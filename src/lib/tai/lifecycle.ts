import { POD_SIGNED_BY_MAX, type TaiShipmentStatus } from "./api-client";
import { isDeliveryStop, isPickupStop } from "./status";
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
 * One pair for every stop type. `PublicAPIShipmentTrackingUpdateShort` has no
 * delivery-specific arrival/departure fields — the stop is identified by the
 * path parameter, so `actualPickup*` means "this stop's arrival / departure"
 * regardless of whether it is a pickup or a drop.
 */
const STOP_ARRIVAL_FIELD = "actualPickupArrivalDateTime" as const;
const STOP_DEPARTURE_FIELD = "actualPickupDepartureDateTime" as const;

/** Appointment window fields differ by stop type, though (both are on the schema). */
function stopAppointmentFields(stopType: StopType): { begin: string; end: string } {
  // A BOTH stop is delivery-like too; its appointment is sent as the delivery
  // pair, which is the half that gates the receiver.
  return isDeliveryStop(stopType)
    ? { begin: "deliveryAppointmentBeginDateTime", end: "deliveryAppointmentEndDateTime" }
    : { begin: "pickupAppointmentBeginDateTime", end: "pickupAppointmentEndDateTime" };
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
    return { ok: false, error: "This shipment is not linked to TAI yet, so it cannot be updated." };
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
  if (stop.actualArrivalAt) return { ok: false, error: "Arrival has already been recorded here." };
  if (stop.taiShipmentStopId === null) {
    // §4.2's stop endpoint is addressed by TAI's stop id. Without it there is
    // no URL to call.
    return { ok: false, error: "This stop is not linked to TAI yet, so it cannot be updated." };
  }

  const occurredAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.shipmentStop.update({
      where: { id: stop.id },
      data: { actualArrivalAt: occurredAt },
    });

    await recordEvent(tx, {
      shipmentId,
      stopId: stop.id,
      // BOTH counts as a delivery arrival — the freight has reached a drop.
      type: isDeliveryStop(stop.type) ? "ARRIVED_AT_DELIVERY" : "ARRIVED_AT_PICKUP",
      occurredAt,
      details: { sequence: stop.sequence, stopType: stop.type },
      sync: {
        kind: "stopTracking",
        payload: {
          shipmentStopId: stop.taiShipmentStopId!,
          body: { [STOP_ARRIVAL_FIELD]: occurredAt.toISOString() },
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
    return { ok: false, error: "Record arrival here before departure." };
  }
  if (stop.actualDepartureAt) {
    return { ok: false, error: "Departure has already been recorded here." };
  }
  if (stop.taiShipmentStopId === null) {
    return { ok: false, error: "This stop is not linked to TAI yet, so it cannot be updated." };
  }

  const occurredAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.shipmentStop.update({
      where: { id: stop.id },
      data: { actualDepartureAt: occurredAt },
    });

    await recordEvent(tx, {
      shipmentId,
      stopId: stop.id,
      // Departing a stop that collects freight is the moment it is on board.
      type: isPickupStop(stop.type) ? "PICKED_UP" : "IN_TRANSIT",
      occurredAt,
      details: { sequence: stop.sequence, stopType: stop.type },
      sync: {
        kind: "stopTracking",
        payload: {
          shipmentStopId: stop.taiShipmentStopId!,
          body: { [STOP_DEPARTURE_FIELD]: occurredAt.toISOString() },
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
  if (name.length > POD_SIGNED_BY_MAX) {
    return { ok: false, error: `Signature must be ${POD_SIGNED_BY_MAX} characters or fewer.` };
  }

  const shipment = await loadShipment(shipmentId);
  if (!shipment) return { ok: false, error: "Shipment not found." };

  const stop = await loadStop(shipmentId, stopId);
  if (!stop) return { ok: false, error: "Stop not found." };
  if (stop.taiShipmentStopId === null) {
    return { ok: false, error: "This stop is not linked to TAI yet, so it cannot be updated." };
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

// --- Stop appointment windows ---------------------------------------------

/**
 * Updates one stop's appointment window.
 *
 * `PublicAPIShipmentTrackingUpdateShort` carries both a pickup and a delivery
 * appointment pair; which one applies is chosen from the stop's own type.
 *
 * ⚠️ TAI distinguishes *estimated* from *appointment* windows on a stop, while
 * our `shipment_stops` collapses both into `window_start` / `window_end`. An
 * appointment written here therefore overwrites whatever estimate arrived from
 * a webhook. Splitting the columns is the fix if that distinction matters.
 */
export async function updateStopAppointment(
  shipmentId: string,
  stopId: string,
  input: { begin: string; end: string },
): Promise<LifecycleResult> {
  const begin = input.begin ? new Date(input.begin) : null;
  const end = input.end ? new Date(input.end) : null;

  if (!begin || Number.isNaN(begin.getTime())) {
    return { ok: false, error: "Enter a valid appointment start." };
  }
  if (end && Number.isNaN(end.getTime())) {
    return { ok: false, error: "Enter a valid appointment end." };
  }
  if (end && end < begin) {
    return { ok: false, error: "Appointment end cannot be before its start." };
  }

  const shipment = await loadShipment(shipmentId);
  if (!shipment) return { ok: false, error: "Shipment not found." };

  const stop = await loadStop(shipmentId, stopId);
  if (!stop) return { ok: false, error: "Stop not found." };
  if (stop.taiShipmentStopId === null) {
    return { ok: false, error: "This stop is not linked to TAI yet, so it cannot be updated." };
  }

  const occurredAt = new Date();
  const fields = stopAppointmentFields(stop.type);

  await prisma.$transaction(async (tx) => {
    await tx.shipmentStop.update({
      where: { id: stop.id },
      data: { windowStart: begin, windowEnd: end, appointmentTime: begin },
    });

    await recordEvent(tx, {
      shipmentId,
      stopId: stop.id,
      type: "SHIPMENT_DETAILS_UPDATED",
      occurredAt,
      details: {
        sequence: stop.sequence,
        stopType: stop.type,
        appointmentBegin: begin.toISOString(),
        appointmentEnd: end?.toISOString() ?? null,
      },
      sync: {
        kind: "stopTracking",
        payload: {
          shipmentStopId: stop.taiShipmentStopId!,
          body: {
            [fields.begin]: begin.toISOString(),
            ...(end ? { [fields.end]: end.toISOString() } : {}),
          },
        },
      },
    });
  });

  return { ok: true };
}

// --- Shipment-level status ------------------------------------------------

/**
 * Our enum → TAI's `shipmentStatus` label. The two vocabularies line up
 * one-to-one, so every status we hold can be pushed.
 */
const TAI_STATUS_LABEL: Record<ShipmentStatus, TaiShipmentStatus> = {
  QUOTE: "Quote",
  COMMITTED: "Committed",
  READY: "Ready",
  SENT: "Sent",
  DISPATCHED: "Dispatched",
  IN_TRANSIT: "In Transit",
  OUT_FOR_DELIVERY: "Out for Delivery",
  DELIVERED: "Delivered",
  COMPLETE: "Complete",
  CANCELED: "Canceled",
};

/** Statuses that have a dedicated audit event; the rest log the generic one. */
const STATUS_EVENT_TYPE: Partial<Record<ShipmentStatus, ShipmentEventType>> = {
  IN_TRANSIT: "IN_TRANSIT",
  DELIVERED: "DELIVERED",
};

export async function setShipmentStatus(
  shipmentId: string,
  status: ShipmentStatus,
): Promise<LifecycleResult> {
  const shipment = await loadShipment(shipmentId);
  if (!shipment) return { ok: false, error: "Shipment not found." };

  const label = TAI_STATUS_LABEL[status];
  if (!label) return { ok: false, error: "That status is not available." };
  if (shipment.status === status) {
    return { ok: false, error: `Shipment is already ${label}.` };
  }
  if (shipment.taiShipmentId === null) {
    return { ok: false, error: "This shipment is not linked to TAI yet, so it cannot be updated." };
  }

  const occurredAt = new Date();

  // On delivery, the spec lets the shipment-level call carry the POD trio
  // alongside the status, so send whatever the delivery stop already holds.
  const podStop =
    status === "DELIVERED"
      ? await prisma.shipmentStop.findFirst({
          where: { shipmentId, type: { in: ["LAST_DROP", "DROP", "BOTH"] } },
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
      type: STATUS_EVENT_TYPE[status] ?? "SHIPMENT_STATUS_UPDATED",
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
