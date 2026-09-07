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
 * Stop types — TAI's own vocabulary, mirrored exactly.
 *
 * The authoritative list is `PublicAPIShippingAddress.stopType`: **First
 * Pickup, Last Drop, Pick, Drop, Both**. Synonyms are kept alongside because
 * the *webhook* payload schema is not published and need not use the same
 * words as the REST response.
 */
const STOP_TYPE_BY_LABEL: Record<string, StopType> = {
  // Spec enum
  "first pickup": "FIRST_PICKUP",
  "last drop": "LAST_DROP",
  pick: "PICK",
  drop: "DROP",
  both: "BOTH",

  // Synonyms. These map to the generic PICK / DROP rather than the
  // first/last variants, since a payload saying "Pickup" makes no claim
  // about position in the route.
  pickup: "PICK",
  "pick up": "PICK",
  shipper: "PICK",
  origin: "FIRST_PICKUP",
  delivery: "DROP",
  deliver: "DROP",
  consignee: "DROP",
  receiver: "DROP",
  destination: "LAST_DROP",
  "last delivery": "LAST_DROP",
  intermediate: "BOTH",
  stop: "BOTH",
};

/**
 * Unrecognised labels fall back to BOTH — the least lossy choice, since a
 * both-ways stop offers every action. It also warns: silent fallthrough is
 * exactly how "First Pickup" and "Last Drop" were mis-typed for 64 stops
 * before the spec enum was known.
 */
export function mapStopType(label: string | null | undefined): StopType {
  if (!label) return "BOTH";

  const mapped = STOP_TYPE_BY_LABEL[normalizeLabel(label)];
  if (!mapped) {
    console.warn(`[tai] Unmapped stopType "${label}" — defaulting to BOTH.`);
    return "BOTH";
  }

  return mapped;
}

/**
 * Does freight get collected here? `BOTH` answers yes to this *and* to
 * `isDeliveryStop`, which is the whole reason the enum was widened.
 */
export function isPickupStop(type: StopType): boolean {
  return type === "FIRST_PICKUP" || type === "PICK" || type === "BOTH";
}

/** Does freight get dropped here? */
export function isDeliveryStop(type: StopType): boolean {
  return type === "LAST_DROP" || type === "DROP" || type === "BOTH";
}

/** Short label for the UI. */
export function stopTypeLabel(type: StopType): string {
  return {
    FIRST_PICKUP: "First Pickup",
    LAST_DROP: "Last Drop",
    PICK: "Pick",
    DROP: "Drop",
    BOTH: "Both",
  }[type];
}
