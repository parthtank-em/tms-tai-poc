import type { ShipmentStatus, StopType } from "@/generated/prisma/enums";

/**
 * TAI shipment status labels → our enum (findings §4.3).
 *
 * The webhook `Version` setting changes two labels: v2 sends `Booked` where v3
 * sends `Committed`, and `Quoted` where v3 sends `Quote` (§3). Which version is
 * configured for this integration is still an open question (§9), so both
 * vocabularies are accepted unconditionally — the labels do not collide, so
 * there is nothing to gain by guessing the version and rejecting the other set.
 */
const STATUS_BY_LABEL: Record<string, ShipmentStatus> = {
  quote: "QUOTE",
  quoted: "QUOTE", // Version 2
  committed: "COMMITTED",
  booked: "COMMITTED", // Version 2
  ready: "READY",
  sent: "SENT",
  dispatched: "DISPATCHED",
  "in transit": "IN_TRANSIT",
  intransit: "IN_TRANSIT",
  "in-transit": "IN_TRANSIT",
  "out for delivery": "OUT_FOR_DELIVERY",
  outfordelivery: "OUT_FOR_DELIVERY",
  "out-for-delivery": "OUT_FOR_DELIVERY",
  delivered: "DELIVERED",
  complete: "COMPLETE",
  completed: "COMPLETE",
  canceled: "CANCELED",
  cancelled: "CANCELED",
};

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Returns null for a label we have no mapping for — the caller decides. */
export function mapShipmentStatus(label: string | null | undefined): ShipmentStatus | null {
  if (!label) return null;
  return STATUS_BY_LABEL[normalizeLabel(label)] ?? null;
}

/**
 * Stop types. TAI's exact vocabulary is not in the findings doc, so the common
 * TMS synonyms are accepted and anything unrecognised is kept as an
 * intermediate stop rather than dropped.
 */
const STOP_TYPE_BY_LABEL: Record<string, StopType> = {
  pickup: "PICKUP",
  "pick up": "PICKUP",
  pick: "PICKUP",
  shipper: "PICKUP",
  origin: "PICKUP",
  delivery: "DELIVERY",
  deliver: "DELIVERY",
  consignee: "DELIVERY",
  receiver: "DELIVERY",
  destination: "DELIVERY",
  drop: "DELIVERY",
  intermediate: "INTERMEDIATE",
  stop: "INTERMEDIATE",
};

export function mapStopType(label: string | null | undefined): StopType {
  if (!label) return "INTERMEDIATE";
  return STOP_TYPE_BY_LABEL[normalizeLabel(label)] ?? "INTERMEDIATE";
}
