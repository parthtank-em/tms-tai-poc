import {
  ACTIVITY_LOG_CREATE,
  STOP_TRACKING_UPDATE,
  TRACKING_UPDATE,
  type StopTrackingPayload,
} from "./outbound-worker";

import type { Prisma } from "@/generated/prisma/client";
import type { ShipmentEventType, ShipmentStatus, StopType } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

/**
 * Use case 3 — FreightID's internal lifecycle, partially synced to TAI (§4.2).
 *
 * Two rules shape everything here:
 *
 * 1. **Local first.** The operator's action is recorded in FreightID's own
 *    tables and audit trail immediately. Only then is a job queued. A TAI
 *    outage delays the push; it never loses the fact.
 * 2. **Driver assignment does not go to TAI.** §5 is unresolved — the
 *    `Assignments` API is for TAI staff, not drivers, and it is unconfirmed
 *    whether `POST /LogShipmentChanges` persists reference numbers or merely
 *    logs a diff. So `DRIVER_ASSIGNED` is written with `taiSyncStatus: HELD` and
 *    no job is enqueued. See `TODO(§5)` below.
 */

export type LifecycleResult = { ok: true } | { ok: false; error: string };

type TxClient = Prisma.TransactionClient;

/**
 * Records the event and, when the event is one TAI accepts, the job that
 * carries it outward. `HELD` events get an audit row and nothing else.
 */
async function recordEvent(
  tx: TxClient,
  args: {
    shipmentId: string;
    type: ShipmentEventType;
    stopId?: string | null;
    occurredAt: Date;
    details: Prisma.InputJsonValue;
    sync:
      | { kind: "held" }
      | { kind: "none" }
      | { kind: "tracking"; payload: Prisma.InputJsonValue }
      | { kind: "stopTracking"; payload: StopTrackingPayload }
      | { kind: "activityLog"; payload: Prisma.InputJsonValue };
  },
): Promise<void> {
  const event = await tx.shipmentEvent.create({
    data: {
      shipmentId: args.shipmentId,
      stopId: args.stopId ?? null,
      type: args.type,
      source: "FREIGHTID_INTERNAL",
      occurredAt: args.occurredAt,
      details: args.details,
      taiSyncStatus:
        args.sync.kind === "held" ? "HELD" : args.sync.kind === "none" ? "NOT_APPLICABLE" : "PENDING",
    },
    select: { id: true },
  });

  if (args.sync.kind === "held" || args.sync.kind === "none") return;

  const operation =
    args.sync.kind === "tracking"
      ? TRACKING_UPDATE
      : args.sync.kind === "stopTracking"
        ? STOP_TRACKING_UPDATE
        : ACTIVITY_LOG_CREATE;

  await tx.outboundJob.create({
    data: {
      shipmentId: args.shipmentId,
      operation,
      eventId: event.id,
      payload: args.sync.payload as Prisma.InputJsonValue,
    },
  });
}

async function loadShipment(shipmentId: string) {
  return prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: {
      id: true,
      taiShipmentId: true,
      status: true,
      driverId: true,
      driver: { select: { id: true, name: true, verificationStatus: true } },
    },
  });
}

async function loadStop(shipmentId: string, stopId: string) {
  return prisma.shipmentStop.findFirst({
    where: { id: stopId, shipmentId },
    select: {
      id: true,
      type: true,
      sequence: true,
      taiShipmentStopId: true,
      actualArrivalAt: true,
      actualDepartureAt: true,
      podSignedBy: true,
    },
  });
}

/**
 * Field names for `PUT /Tracking/{shipmentStopId}`.
 *
 * ⚠️ §4.2 documents only the pickup pair (`actualPickupArrivalDateTime` /
 * `actualPickupDepartureDateTime`). The delivery equivalents are not specified,
 * so the POD names the shipment-level call uses are applied by analogy. Confirm
 * with TAI before trusting delivery-stop pushes — the local columns are correct
 * either way, so only the outbound body is at risk.
 */
function stopTimestampFields(stopType: StopType): { arrival: string; departure: string } {
  return stopType === "DELIVERY"
    ? { arrival: "proofOfDeliveryArrivalDateTime", departure: "proofOfDeliveryDepartureDateTime" }
    : { arrival: "actualPickupArrivalDateTime", departure: "actualPickupDepartureDateTime" };
}

// --- Driver (§5: local only) ----------------------------------------------

export async function assignDriver(
  shipmentId: string,
  input: { name: string; phone?: string },
): Promise<LifecycleResult> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "Enter the driver's name." };

  const phone = input.phone?.trim() || null;
  const shipment = await loadShipment(shipmentId);
  if (!shipment) return { ok: false, error: "Shipment not found." };

  const occurredAt = new Date();

  await prisma.$transaction(async (tx) => {
    // Reuse a driver with the same name and phone rather than accumulating
    // duplicates; there is no driver directory yet.
    const existing = await tx.driver.findFirst({
      where: { name, phone },
      select: { id: true },
    });

    const driver =
      existing ?? (await tx.driver.create({ data: { name, phone }, select: { id: true } }));

    await tx.shipment.update({
      where: { id: shipmentId },
      data: { driverId: driver.id, driverAssignedAt: occurredAt },
    });

    // TODO(§5): once TAI confirms whether POST /LogShipmentChanges persists
    // reference numbers (Driver Name / Driver Cell Phone Number) or only logs a
    // diff, change `sync` to enqueue that call. Until then this stays HELD —
    // recorded locally, deliberately not sent.
    await recordEvent(tx, {
      shipmentId,
      type: "DRIVER_ASSIGNED",
      occurredAt,
      details: { driverId: driver.id, name, phone },
      sync: { kind: "held" },
    });
  });

  return { ok: true };
}

export async function verifyDriverIdentity(shipmentId: string): Promise<LifecycleResult> {
  const shipment = await loadShipment(shipmentId);
  if (!shipment) return { ok: false, error: "Shipment not found." };
  if (!shipment.driver) return { ok: false, error: "Assign a driver before verifying identity." };
  if (shipment.taiShipmentId === null) {
    return { ok: false, error: "This shipment has no TAI shipment ID, so nothing can be synced." };
  }

  const occurredAt = new Date();
  const description = `Driver identity verified for ${shipment.driver.name}.`;

  await prisma.$transaction(async (tx) => {
    await tx.driver.update({
      where: { id: shipment.driver!.id },
      data: { verificationStatus: "VERIFIED", verifiedAt: occurredAt },
    });

    await tx.shipment.update({
      where: { id: shipmentId },
      data: { driverIdentityVerifiedAt: occurredAt },
    });

    // Unlike assignment, this one IS confirmed (§4.2): a free-text activity log.
    await recordEvent(tx, {
      shipmentId,
      type: "DRIVER_IDENTITY_VERIFIED",
      occurredAt,
      details: { driverId: shipment.driver!.id, description },
      sync: {
        kind: "activityLog",
        payload: {
          shipmentId: shipment.taiShipmentId,
          type: "Operations",
          description,
          privacy: "Public",
        },
      },
    });
  });

  return { ok: true };
}

// --- Stop-scoped events (§4.2) --------------------------------------------

export async function recordStopArrival(
  shipmentId: string,
  stopId: string,
): Promise<LifecycleResult> {
  const shipment = await loadShipment(shipmentId);
  if (!shipment) return { ok: false, error: "Shipment not found." };

  const stop = await loadStop(shipmentId, stopId);
  if (!stop) return { ok: false, error: "Stop not found." };
  if (stop.actualArrivalAt) return { ok: false, error: "Arrival is already recorded on this stop." };
  if (stop.taiShipmentStopId === null) {
    // §4.2's stop endpoint is addressed by TAI's stop id. Without it there is
    // no URL to call.
    return { ok: false, error: "This stop has no TAI stop ID, so it cannot be synced." };
  }

  const occurredAt = new Date();
  const fields = stopTimestampFields(stop.type);

  await prisma.$transaction(async (tx) => {
    await tx.shipmentStop.update({
      where: { id: stop.id },
      data: { actualArrivalAt: occurredAt },
    });

    await recordEvent(tx, {
      shipmentId,
      stopId: stop.id,
      type: stop.type === "DELIVERY" ? "ARRIVED_AT_DELIVERY" : "ARRIVED_AT_PICKUP",
      occurredAt,
      details: { sequence: stop.sequence, stopType: stop.type },
      sync: {
        kind: "stopTracking",
        payload: {
          shipmentStopId: stop.taiShipmentStopId!,
          body: { [fields.arrival]: occurredAt.toISOString() },
        },
      },
    });
  });

  return { ok: true };
}

export async function recordStopDeparture(
  shipmentId: string,
  stopId: string,
): Promise<LifecycleResult> {
  const shipment = await loadShipment(shipmentId);
  if (!shipment) return { ok: false, error: "Shipment not found." };

  const stop = await loadStop(shipmentId, stopId);
  if (!stop) return { ok: false, error: "Stop not found." };
  if (!stop.actualArrivalAt) {
    return { ok: false, error: "Record arrival at this stop before departure." };
  }
  if (stop.actualDepartureAt) {
    return { ok: false, error: "Departure is already recorded on this stop." };
  }
  if (stop.taiShipmentStopId === null) {
    return { ok: false, error: "This stop has no TAI stop ID, so it cannot be synced." };
  }

  const occurredAt = new Date();
  const fields = stopTimestampFields(stop.type);

  await prisma.$transaction(async (tx) => {
    await tx.shipmentStop.update({
      where: { id: stop.id },
      data: { actualDepartureAt: occurredAt },
    });

    await recordEvent(tx, {
      shipmentId,
      stopId: stop.id,
      // Departing the pickup is the moment the freight is on board.
      type: stop.type === "PICKUP" ? "PICKED_UP" : "IN_TRANSIT",
      occurredAt,
      details: { sequence: stop.sequence, stopType: stop.type },
      sync: {
        kind: "stopTracking",
        payload: {
          shipmentStopId: stop.taiShipmentStopId!,
          body: { [fields.departure]: occurredAt.toISOString() },
        },
      },
    });
  });

  return { ok: true };
}

export async function capturePod(
  shipmentId: string,
  stopId: string,
  signedBy: string,
): Promise<LifecycleResult> {
  const name = signedBy.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "Enter who signed for the delivery." };

  const shipment = await loadShipment(shipmentId);
  if (!shipment) return { ok: false, error: "Shipment not found." };

  const stop = await loadStop(shipmentId, stopId);
  if (!stop) return { ok: false, error: "Stop not found." };
  if (stop.taiShipmentStopId === null) {
    return { ok: false, error: "This stop has no TAI stop ID, so it cannot be synced." };
  }

  const occurredAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.shipmentStop.update({
      where: { id: stop.id },
      data: {
        podSignedBy: name,
        podArrivalAt: stop.actualArrivalAt ?? occurredAt,
        podDepartureAt: occurredAt,
      },
    });

    // §4.2 offers both the shipment- and stop-level endpoint for the signature.
    // The stop-level one is used so a multi-stop POD lands on the right stop.
    await recordEvent(tx, {
      shipmentId,
      stopId: stop.id,
      type: "POD_CAPTURED",
      occurredAt,
      details: { sequence: stop.sequence, signedBy: name },
      sync: {
        kind: "stopTracking",
        payload: {
          shipmentStopId: stop.taiShipmentStopId!,
          body: { proofOfDeliverySignedBy: name },
        },
      },
    });
  });

  return { ok: true };
}

// --- Shipment-level status (§4.2) -----------------------------------------

/** TAI's label for each status we push (§4.3). */
const TAI_STATUS_LABEL: Partial<Record<ShipmentStatus, string>> = {
  IN_TRANSIT: "In Transit",
  DELIVERED: "Delivered",
};

export async function setShipmentStatus(
  shipmentId: string,
  status: "IN_TRANSIT" | "DELIVERED",
): Promise<LifecycleResult> {
  const shipment = await loadShipment(shipmentId);
  if (!shipment) return { ok: false, error: "Shipment not found." };
  if (shipment.status === status) {
    return { ok: false, error: `Shipment is already ${TAI_STATUS_LABEL[status]}.` };
  }
  if (shipment.status === "CANCELED") {
    return { ok: false, error: "This shipment is canceled." };
  }
  if (shipment.taiShipmentId === null) {
    return { ok: false, error: "This shipment has no TAI shipment ID, so nothing can be synced." };
  }

  const occurredAt = new Date();
  const label = TAI_STATUS_LABEL[status]!;

  // On delivery, §4.2 wants the POD timestamp pair alongside the status.
  const podStop =
    status === "DELIVERED"
      ? await prisma.shipmentStop.findFirst({
          where: { shipmentId, type: "DELIVERY" },
          orderBy: { sequence: "desc" },
          select: { podArrivalAt: true, podDepartureAt: true, podSignedBy: true },
        })
      : null;

  await prisma.$transaction(async (tx) => {
    await tx.shipment.update({
      where: { id: shipmentId },
      data: { status, taiStatusLabel: label },
    });

    await recordEvent(tx, {
      shipmentId,
      type: status === "IN_TRANSIT" ? "IN_TRANSIT" : "DELIVERED",
      occurredAt,
      details: { status, taiLabel: label },
      sync: {
        kind: "tracking",
        payload: {
          shipmentId: shipment.taiShipmentId,
          trackingUpdate: {
            shipmentStatus: label,
            ...(podStop?.podArrivalAt
              ? { proofOfDeliveryArrivalDateTime: podStop.podArrivalAt.toISOString() }
              : {}),
            ...(podStop?.podDepartureAt
              ? { proofOfDeliveryDepartureDateTime: podStop.podDepartureAt.toISOString() }
              : {}),
            ...(podStop?.podSignedBy ? { proofOfDeliverySignedBy: podStop.podSignedBy } : {}),
          },
        },
      },
    });
  });

  return { ok: true };
}
