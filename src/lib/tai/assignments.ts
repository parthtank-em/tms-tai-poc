import { createAssignment, isValidTaiShipmentId } from "./api-client";
import { isKnownStaffId } from "./staff";

import { prisma } from "@/lib/prisma";

/**
 * Staff assignment — `POST /PublicApi/Shipping/v2/Assignments`.
 *
 * Like reference numbers and unlike alerts, this is a direct call rather than a
 * queued job: there is no local `assignments` table, so there is nothing to
 * record durably first and nothing for a worker to reconcile against. A failed
 * assignment means nothing changed anywhere, which is what the operator is told.
 *
 * TAI offers no endpoint to read assignments back, so the modal cannot show who
 * a shipment is currently assigned to — only make a new assignment (§9).
 */

export type AssignmentResult =
  | { ok: true; assignmentId: number | null }
  | { ok: false; error: string };

/**
 * The response is a bare int32, not an object. Parsed leniently: the assignment
 * succeeded either way, and the id is a nicety we show, not something to fail on.
 */
function toAssignmentId(data: unknown): number | null {
  if (typeof data === "number" && Number.isInteger(data)) return data;
  if (typeof data === "string" && /^\d+$/.test(data.trim())) return Number(data.trim());
  return null;
}

export async function assignStaff(
  shipmentId: string,
  staffId: number,
): Promise<AssignmentResult> {
  if (!Number.isInteger(staffId) || staffId < 1) {
    return { ok: false, error: "Select a staff member." };
  }

  // The dropdown only offers ids TAI gave us; this catches a hand-crafted
  // request. `null` means we have no roster to check against, in which case we
  // let it through rather than block on TAI being reachable.
  if (isKnownStaffId(staffId) === false) {
    return { ok: false, error: "That staff member is not on the roster TAI returned." };
  }

  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: { taiShipmentId: true },
  });

  if (!shipment) {
    return { ok: false, error: "Shipment not found." };
  }

  if (!isValidTaiShipmentId(shipment.taiShipmentId)) {
    return {
      ok: false,
      error: "This shipment is not linked to TAI yet, so it cannot be assigned.",
    };
  }

  // `activityLogId` is left off: it ties the assignment to an activity log
  // entry, and we have no id to give it.
  const result = await createAssignment(
    { shipmentId: shipment.taiShipmentId, staffId },
    { shipmentId, attempt: 1 },
  );

  if (!result.ok) {
    // The raw TAI error stays in `tai_api_calls`; the operator gets the outcome.
    return { ok: false, error: "TAI rejected the assignment. Nothing has been assigned." };
  }

  return { ok: true, assignmentId: toAssignmentId(result.data) };
}
