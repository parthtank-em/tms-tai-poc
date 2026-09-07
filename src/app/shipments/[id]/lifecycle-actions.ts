"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { requireSession } from "@/lib/auth/guard";
import type { ShipmentStatus } from "@/generated/prisma/enums";
import {
  assignDriver,
  capturePod,
  recordStopArrival,
  recordStopDeparture,
  setShipmentStatus,
  updateStopAppointment,
  verifyDriverIdentity,
  type LifecycleResult,
} from "@/lib/tai/lifecycle";
import { drainOutboundJobs } from "@/lib/tai/outbound-worker";

export type ActionState = { error: string | null; notice: string | null };

/**
 * Pushes freshly queued jobs at TAI without making the operator wait. Failure
 * here is not failure of the action — the job row is durable and the worker
 * retries it.
 */
function kickWorker() {
  after(async () => {
    try {
      await drainOutboundJobs(5);
    } catch (cause) {
      console.error("[outbound] drain failed:", cause);
    }
  });
}

async function run(
  shipmentId: string,
  notice: string,
  work: () => Promise<LifecycleResult>,
): Promise<ActionState> {
  await requireSession();

  const result = await work();
  if (!result.ok) return { error: result.error, notice: null };

  kickWorker();
  revalidatePath(`/shipments/${shipmentId}`);

  return { error: null, notice };
}

export async function assignDriverAction(formData: FormData): Promise<ActionState> {
  const shipmentId = String(formData.get("shipmentId") ?? "");
  const name = String(formData.get("driverName") ?? "");
  const phone = String(formData.get("driverPhone") ?? "");

  return run(shipmentId, "Driver assigned.", () =>
    assignDriver(shipmentId, { name, phone }),
  );
}

export async function verifyDriverAction(formData: FormData): Promise<ActionState> {
  const shipmentId = String(formData.get("shipmentId") ?? "");

  return run(shipmentId, "Driver identity verified.", () =>
    verifyDriverIdentity(shipmentId),
  );
}

export async function stopArrivalAction(formData: FormData): Promise<ActionState> {
  const shipmentId = String(formData.get("shipmentId") ?? "");
  const stopId = String(formData.get("stopId") ?? "");

  return run(shipmentId, "Arrival recorded.", () =>
    recordStopArrival(shipmentId, stopId),
  );
}

export async function stopDepartureAction(formData: FormData): Promise<ActionState> {
  const shipmentId = String(formData.get("shipmentId") ?? "");
  const stopId = String(formData.get("stopId") ?? "");

  return run(shipmentId, "Departure recorded.", () =>
    recordStopDeparture(shipmentId, stopId),
  );
}

export async function capturePodAction(formData: FormData): Promise<ActionState> {
  const shipmentId = String(formData.get("shipmentId") ?? "");
  const stopId = String(formData.get("stopId") ?? "");
  const signedBy = String(formData.get("signedBy") ?? "");

  return run(shipmentId, "Proof of delivery saved.", () =>
    capturePod(shipmentId, stopId, signedBy),
  );
}

/** Every status our enum holds maps 1:1 onto TAI's, so all ten are allowed. */
const STATUSES: ShipmentStatus[] = [
  "QUOTE",
  "COMMITTED",
  "READY",
  "SENT",
  "DISPATCHED",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "COMPLETE",
  "CANCELED",
];

export async function setStatusAction(formData: FormData): Promise<ActionState> {
  const shipmentId = String(formData.get("shipmentId") ?? "");
  const status = String(formData.get("status") ?? "") as ShipmentStatus;

  if (!STATUSES.includes(status)) {
    return { error: "That status is not available.", notice: null };
  }

  return run(shipmentId, "Status updated.", () =>
    setShipmentStatus(shipmentId, status),
  );
}

export async function updateAppointmentAction(formData: FormData): Promise<ActionState> {
  const shipmentId = String(formData.get("shipmentId") ?? "");
  const stopId = String(formData.get("stopId") ?? "");
  const begin = String(formData.get("appointmentBegin") ?? "");
  const end = String(formData.get("appointmentEnd") ?? "");

  return run(shipmentId, "Appointment updated.", () =>
    updateStopAppointment(shipmentId, stopId, { begin, end }),
  );
}
