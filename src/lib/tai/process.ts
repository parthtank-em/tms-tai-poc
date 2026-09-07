import { normalizeShipmentPayload, type NormalizedShipment, type NormalizedStop } from "./payload";
import { mapShipmentStatus } from "./status";

import type { Prisma } from "@/generated/prisma/client";
import type { ShipmentEventType, ShipmentStatus, WebhookType } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

/**
 * Asynchronous half of inbound webhook handling (findings §3).
 *
 * The route has already acked TAI with 200 and persisted the raw body. This
 * runs afterwards, so a failure here never turns into a non-2xx on the wire —
 * it lands in `webhook_events.processing_status` / `.error` instead, which is
 * the only record of the delivery we will ever have (TAI's own
 * `WebhookActivityLogs` are not visible to us and nothing is ever re-sent).
 */

const EVENT_TYPE_BY_WEBHOOK: Record<WebhookType, ShipmentEventType> = {
  SHIPMENT_CREATE: "SHIPMENT_CREATED",
  SHIPMENT_DETAIL_UPDATE: "SHIPMENT_DETAILS_UPDATED",
  SHIPMENT_STATUS_UPDATE: "SHIPMENT_STATUS_UPDATED",
  SHIPMENT_LOCATION_UPDATE: "LOCATION_UPDATED",
  OTHER: "SHIPMENT_DETAILS_UPDATED",
};

type WithoutNulls<T> = { [K in keyof T]?: Exclude<T[K], null> };

/**
 * Drops nulls so an update only writes fields the delivery actually carried.
 * A status-update webhook that omits carrier detail must not blank the carrier
 * columns a create webhook already filled in.
 */
function omitNullish<T extends Record<string, unknown>>(data: T): WithoutNulls<T> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== null && value !== undefined),
  ) as WithoutNulls<T>;
}

/**
 * Nullable scalar columns only. `loadHazmat` (non-nullable) and
 * `loadDimensions` (nullable Json, which Prisma writes with `DbNull` rather
 * than a bare null) are applied separately.
 */
function shipmentFields(normalized: NormalizedShipment) {
  return {
    shipmentType: normalized.shipmentType,
    serviceLevel: normalized.serviceLevel,
    mileage: normalized.mileage,
    proNumber: normalized.proNumber,
    bolNumber: normalized.bolNumber,
    poNumber: normalized.poNumber,
    shipperReference: normalized.shipperReference,
    customerName: normalized.customerName,
    loadDescription: normalized.loadDescription,
    loadQuantity: normalized.loadQuantity,
    loadPieces: normalized.loadPieces,
    loadWeightLb: normalized.loadWeightLb,
    carrierName: normalized.carrierName,
    carrierMcNumber: normalized.carrierMcNumber,
    carrierScac: normalized.carrierScac,
    carrierPhone: normalized.carrierPhone,
    secondaryDriverName: normalized.secondaryDriverName,
    secondaryDriverPhone: normalized.secondaryDriverPhone,
  };
}

/** Only written when the delivery actually carried dimensions. */
function loadDimensionsPatch(normalized: NormalizedShipment) {
  return normalized.loadDimensions
    ? { loadDimensions: normalized.loadDimensions as Prisma.InputJsonValue }
    : {};
}

function stopFields(stop: NormalizedStop) {
  return {
    companyName: stop.companyName,
    address1: stop.address1,
    address2: stop.address2,
    city: stop.city,
    state: stop.state,
    postalCode: stop.postalCode,
    country: stop.country,
    windowStart: stop.windowStart,
    windowEnd: stop.windowEnd,
    appointmentTime: stop.appointmentTime,
    // Actuals TAI already recorded. Written here so a shipment that moved
    // before we saw it does not look untouched; `omitNullish` keeps a later
    // payload without them from wiping what we have.
    actualArrivalAt: stop.actualArrivalAt,
    actualDepartureAt: stop.actualDepartureAt,
  };
}

/**
 * Resolves the status column.
 *
 * - Label present and mappable → use it.
 * - Label present but unmapped → throw. Guessing would write a wrong lifecycle
 *   state, and the raw payload is safe in `webhook_events`, so failing loudly
 *   and reprocessing later is strictly better. This is also the tripwire that
 *   catches a Version-2 vs Version-3 mismatch (§3, §9).
 * - Label absent → null; the caller defaults a brand-new shipment to the
 *   earliest lifecycle state and leaves an existing one untouched.
 */
function resolveStatus(label: string | null): ShipmentStatus | null {
  if (!label) return null;

  const status = mapShipmentStatus(label);
  if (!status) {
    throw new Error(
      `Unmapped TAI shipmentStatus "${label}". Add it to STATUS_BY_LABEL in src/lib/tai/status.ts.`,
    );
  }

  return status;
}

async function applyShipmentPayload(
  webhookEventId: string,
  webhookType: WebhookType,
  normalized: NormalizedShipment,
): Promise<string> {
  const taiShipmentId = normalized.taiShipmentId;
  if (taiShipmentId === null) {
    throw new Error("Payload carries no TAI shipment id — cannot match or create a shipment.");
  }

  const status = resolveStatus(normalized.statusLabel);
  const fields = shipmentFields(normalized);
  const seenAt = new Date();

  return prisma.$transaction(async (tx) => {
    const shipment = await tx.shipment.upsert({
      where: { taiShipmentId },
      create: {
        ...fields,
        ...loadDimensionsPatch(normalized),
        taiShipmentId,
        // A shipment row needs a status. When TAI sent no label at all, the
        // earliest lifecycle state is the only non-fabricated choice.
        status: status ?? "QUOTE",
        taiStatusLabel: normalized.statusLabel,
        loadHazmat: normalized.loadHazmat ?? false,
        taiLastSeenAt: seenAt,
      },
      update: {
        ...omitNullish(fields),
        ...loadDimensionsPatch(normalized),
        ...(normalized.loadHazmat !== null ? { loadHazmat: normalized.loadHazmat } : {}),
        ...(status ? { status } : {}),
        ...(normalized.statusLabel ? { taiStatusLabel: normalized.statusLabel } : {}),
        taiLastSeenAt: seenAt,
      },
      select: { id: true },
    });

    for (const stop of normalized.stops) {
      const shared = stopFields(stop);
      const create = {
        ...shared,
        shipmentId: shipment.id,
        taiShipmentStopId: stop.taiShipmentStopId,
        type: stop.type,
        sequence: stop.sequence,
      };
      const update = { ...omitNullish(shared), type: stop.type, sequence: stop.sequence };

      if (stop.taiShipmentStopId !== null) {
        await tx.shipmentStop.upsert({
          where: { taiShipmentStopId: stop.taiShipmentStopId },
          create,
          update,
        });
      } else {
        // No TAI stop id in the payload — fall back to position within the
        // shipment. Note this stop cannot be addressed by
        // `PUT /Tracking/{shipmentStopId}` (§4.2) until TAI gives us its id.
        await tx.shipmentStop.upsert({
          where: { shipmentId_sequence: { shipmentId: shipment.id, sequence: stop.sequence } },
          create,
          update,
        });
      }
    }

    await tx.shipmentEvent.create({
      data: {
        shipmentId: shipment.id,
        type: EVENT_TYPE_BY_WEBHOOK[webhookType],
        source: "TAI_WEBHOOK",
        occurredAt: seenAt,
        // Inbound events describe something TAI already knows about, so there
        // is nothing to push back.
        taiSyncStatus: "NOT_APPLICABLE",
        webhookEventId,
        details: {
          webhookType,
          taiShipmentId,
          taiStatusLabel: normalized.statusLabel,
          mappedStatus: status,
          stopsInPayload: normalized.stops.length,
        },
      },
    });

    return shipment.id;
  });
}

/** Idempotent: a delivery already marked PROCESSED is left alone. */
export async function processWebhookEvent(webhookEventId: string): Promise<void> {
  const event = await prisma.webhookEvent.findUnique({
    where: { id: webhookEventId },
    select: { id: true, type: true, rawPayload: true, processingStatus: true },
  });

  if (!event || event.processingStatus === "PROCESSED") {
    return;
  }

  await prisma.webhookEvent.update({
    where: { id: event.id },
    data: { processingStatus: "PROCESSING", attemptCount: { increment: 1 } },
  });

  try {
    const normalized = normalizeShipmentPayload(event.rawPayload);
    if (!normalized) {
      throw new Error("Payload is not a JSON object.");
    }

    const shipmentId = await applyShipmentPayload(event.id, event.type, normalized);

    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        processingStatus: "PROCESSED",
        processedAt: new Date(),
        taiShipmentId: normalized.taiShipmentId,
        shipmentId,
        error: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tai-webhook] Processing failed for ${event.id}: ${message}`);

    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        processingStatus: "FAILED",
        processedAt: new Date(),
        error: message,
      },
    });
  }
}
