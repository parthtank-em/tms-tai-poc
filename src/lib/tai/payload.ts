import { mapStopType } from "./status";

import type { StopType } from "@/generated/prisma/enums";

/**
 * Normalizes a TAI shipment webhook body into the shape our tables want.
 *
 * ⚠️ The findings doc specifies the transport (POST, `application/json`, UTF-8,
 * camelCase, ISO 8601 UTC — §3) but not the field-by-field payload schema, and
 * we have no sandbox capture yet. So each field is read through a short list of
 * plausible aliases rather than one hard-coded key, and anything unrecognised
 * is simply left null — the untouched body is always kept in
 * `webhook_events.raw_payload`, so nothing is lost and a delivery can be
 * reprocessed once the real schema is confirmed.
 */

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** First alias present and non-empty. */
function pick(source: Json | null, ...keys: string[]): unknown {
  if (!source) return undefined;

  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return undefined;
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function int(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(lowered)) return true;
    if (["false", "no", "n", "0"].includes(lowered)) return false;
  }
  if (typeof value === "number") return value !== 0;
  return null;
}

function date(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export type NormalizedStop = {
  taiShipmentStopId: number | null;
  type: StopType;
  sequence: number;
  companyName: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  appointmentTime: Date | null;
};

export type NormalizedShipment = {
  taiShipmentId: number | null;
  shipmentType: string | null;
  serviceLevel: string | null;
  statusLabel: string | null;
  mileage: number | null;
  proNumber: string | null;
  bolNumber: string | null;
  poNumber: string | null;
  shipperReference: string | null;
  loadDescription: string | null;
  loadQuantity: number | null;
  loadPieces: number | null;
  loadWeightLb: number | null;
  loadHazmat: boolean | null;
  loadDimensions: Json | null;
  carrierName: string | null;
  carrierMcNumber: string | null;
  carrierScac: string | null;
  carrierPhone: string | null;
  secondaryDriverName: string | null;
  secondaryDriverPhone: string | null;
  stops: NormalizedStop[];
};

function normalizeStop(raw: unknown, fallbackSequence: number, fallbackType?: StopType): NormalizedStop | null {
  const stop = asRecord(raw);
  if (!stop) return null;

  const address = asRecord(pick(stop, "address", "location")) ?? stop;

  return {
    taiShipmentStopId: int(pick(stop, "shipmentStopId", "stopId", "id")),
    type: fallbackType ?? mapStopType(str(pick(stop, "stopType", "type", "kind"))),
    sequence: int(pick(stop, "sequence", "stopSequence", "order", "sequenceNumber")) ?? fallbackSequence,
    companyName: str(pick(stop, "companyName", "company", "name", "locationName")),
    address1: str(pick(address, "address1", "addressLine1", "street1", "address", "street")),
    address2: str(pick(address, "address2", "addressLine2", "street2")),
    city: str(pick(address, "city")),
    state: str(pick(address, "state", "stateProvince", "province")),
    postalCode: str(pick(address, "postalCode", "zip", "zipCode", "postCode")),
    country: str(pick(address, "country", "countryCode")),
    windowStart: date(
      pick(stop, "windowStart", "earliestDateTime", "earliestDate", "scheduledEarliest", "openTime"),
    ),
    windowEnd: date(pick(stop, "windowEnd", "latestDateTime", "latestDate", "scheduledLatest", "closeTime")),
    appointmentTime: date(pick(stop, "appointmentTime", "appointmentDateTime", "appointment")),
  };
}

function normalizeStops(body: Json): NormalizedStop[] {
  const rawStops = pick(body, "stops", "shipmentStops", "stopList");

  if (Array.isArray(rawStops)) {
    return rawStops
      .map((stop, index) => normalizeStop(stop, index + 1))
      .filter((stop): stop is NormalizedStop => stop !== null)
      .map((stop, index) => ({ ...stop, sequence: stop.sequence || index + 1 }));
  }

  // §7 sketches the shipment as pickup + receiver rather than a stop list, so
  // fall back to that shape and synthesize the two rows the table expects.
  const stops: NormalizedStop[] = [];
  const pickup = normalizeStop(pick(body, "pickup", "shipper", "origin"), 1, "FIRST_PICKUP");
  if (pickup) stops.push(pickup);

  const delivery = normalizeStop(
    pick(body, "receiver", "consignee", "delivery", "destination"),
    stops.length + 1,
    "LAST_DROP",
  );
  if (delivery) stops.push(delivery);

  return stops;
}

export function normalizeShipmentPayload(raw: unknown): NormalizedShipment | null {
  const outer = asRecord(raw);
  if (!outer) return null;

  // TAI may deliver the shipment at the top level or nested under a wrapper.
  const body = asRecord(pick(outer, "shipment", "shipmentDetails", "data", "payload")) ?? outer;

  const load = asRecord(pick(body, "load", "loadDetails", "loadInfo"));
  const carrier = asRecord(pick(body, "carrier", "carrierInfo", "carrierDetails"));

  return {
    taiShipmentId: int(pick(body, "shipmentId", "taiShipmentId", "id")),
    shipmentType: str(pick(body, "shipmentType", "type", "modeName", "mode")),
    serviceLevel: str(pick(body, "serviceLevel", "serviceType", "service")),
    statusLabel: str(pick(body, "shipmentStatus", "status", "statusName")),
    mileage: num(pick(body, "mileage", "miles", "totalMiles", "distance")),
    proNumber: str(pick(body, "proNumber", "pro")),
    bolNumber: str(pick(body, "bolNumber", "bol", "billOfLading")),
    poNumber: str(pick(body, "poNumber", "po", "purchaseOrder", "purchaseOrderNumber")),
    shipperReference: str(
      pick(body, "shipperReference", "shipperReferenceNumber", "customerReference", "refNumber"),
    ),
    loadDescription: str(pick(load, "description", "commodity", "commodityDescription") ?? pick(body, "loadDescription", "commodity")),
    loadQuantity: int(pick(load, "quantity", "qty") ?? pick(body, "loadQuantity", "quantity")),
    loadPieces: int(pick(load, "pieces", "pieceCount") ?? pick(body, "loadPieces", "pieces")),
    loadWeightLb: num(pick(load, "weight", "weightLb", "totalWeight") ?? pick(body, "loadWeight", "weight")),
    loadHazmat: bool(pick(load, "hazmat", "isHazmat", "hazmatFlag") ?? pick(body, "hazmat", "isHazmat")),
    loadDimensions: asRecord(pick(load, "dimensions", "dims") ?? pick(body, "dimensions")),
    carrierName: str(pick(carrier, "name", "carrierName") ?? pick(body, "carrierName")),
    carrierMcNumber: str(pick(carrier, "mcNumber", "mc") ?? pick(body, "carrierMcNumber", "mcNumber")),
    carrierScac: str(pick(carrier, "scac") ?? pick(body, "carrierScac", "scac")),
    carrierPhone: str(pick(carrier, "phone", "phoneNumber") ?? pick(body, "carrierPhone")),
    // §4.3: TAI carries drivers as shipment reference numbers, and
    // `PublicAPIShipmentDetails` exposes `driverCellPhoneNumber` at the top
    // level. Only the secondary-driver columns are written from inbound data —
    // the primary `Driver` relation stays FreightID-owned until §5 is resolved.
    secondaryDriverName: str(pick(body, "secondaryDriverName", "driverName")),
    secondaryDriverPhone: str(
      pick(body, "secondaryDriverCellPhoneNumber", "driverCellPhoneNumber", "driverPhone"),
    ),
    stops: normalizeStops(body),
  };
}
