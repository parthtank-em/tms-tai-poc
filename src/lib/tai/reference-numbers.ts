import {
  asReferenceNumbers,
  deleteShipmentReferenceNumbers,
  getShipmentReferenceNumbers,
  isValidTaiShipmentId,
  updateShipmentReferenceNumbers,
  type PublicApiShipmentReferenceNumberV2,
} from "./api-client";
import {
  REFERENCE_VALUE_MAX,
  normalizeReferenceValue,
  referenceKey,
  type ReferenceNumber,
} from "./reference-types";

import { prisma } from "@/lib/prisma";

/**
 * Shipment reference numbers — `/PublicApi/Shipping/v2/ShipmentReferenceNumbers`.
 *
 * Unlike alerts, these are **not** routed through the outbound queue. There is
 * no local table behind them: TAI holds the list, so every read and write talks
 * to TAI directly and the dialog shows what TAI returned rather than a local
 * mirror that could drift.
 *
 * Two operations only — add and remove. Changing a value means removing the
 * entry and adding it back, so nothing here depends on how TAI treats a write
 * onto a type that already exists (`api-client.ts` records why that is not
 * something to rely on).
 *
 * See `toReferenceNumbers` for the duplicate rows TAI returns on read.
 *
 * The one type this POC writes is "Driver Name" — the schema notes on
 * `Shipment.driverId` record why: TAI models a driver as a shipment reference
 * number, not as an entity of its own.
 */

export type ReferenceNumbersResult = {
  referenceNumbers: ReferenceNumber[];
  error: string | null;
};

export type ReferenceNumberMutationResult = { ok: true } | { ok: false; error: string };

/**
 * ⚠️ TAI returns our written entry **twice**.
 *
 * Observed on shipment 131391979: the list held no `Driver Name` at all, one
 * was written, and both the PUT response and every later GET came back as
 * `[Driver Name, Shipment Id, Driver Name]` — one write, two identical rows,
 * bracketing the system-generated entry. A single DELETE by type clears both.
 * The cause is on TAI's side and is still unexplained (§9).
 *
 * Collapsing on `referenceType` **and** `value` is the narrow fix: it removes
 * only rows that are indistinguishable in both fields, so if a type legitimately
 * carries two different values they both still show. Hiding a real second value
 * would be worse than the duplicate it cured.
 */
function toReferenceNumbers(data: unknown): ReferenceNumber[] {
  const seen = new Set<string>();

  return asReferenceNumbers(data)
    .map((entry: PublicApiShipmentReferenceNumberV2) => ({
      referenceType: typeof entry.referenceType === "string" ? entry.referenceType.trim() : "",
      value: typeof entry.value === "string" ? entry.value.trim() : "",
    }))
    .filter((entry) => {
      if (entry.referenceType.length === 0) return false;

      const key = referenceKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.referenceType.localeCompare(b.referenceType));
}

/**
 * Resolves our uuid to TAI's integer id. Every operation here is addressed by
 * that id, so a shipment without one cannot take part at all.
 */
async function resolveTaiShipmentId(
  shipmentId: string,
): Promise<{ ok: true; taiShipmentId: number } | { ok: false; error: string }> {
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
      error: "This shipment is not linked to TAI yet, so reference numbers are unavailable.",
    };
  }

  return { ok: true, taiShipmentId: shipment.taiShipmentId };
}

export async function listReferenceNumbers(shipmentId: string): Promise<ReferenceNumbersResult> {
  const resolved = await resolveTaiShipmentId(shipmentId);
  if (!resolved.ok) {
    return { referenceNumbers: [], error: resolved.error };
  }

  const result = await getShipmentReferenceNumbers(resolved.taiShipmentId, {
    shipmentId,
    attempt: 1,
  });

  if (!result.ok) {
    return { referenceNumbers: [], error: "Could not load reference numbers from TAI." };
  }

  return { referenceNumbers: toReferenceNumbers(result.data), error: null };
}

/**
 * Adds a reference number. There is no update path: to change a value, remove
 * the entry and add it again. That keeps each operation a single call whose
 * outcome is plain, and sidesteps TAI's unverified replace semantics entirely.
 */
export async function addReferenceNumber(
  shipmentId: string,
  referenceType: string,
  rawValue: string,
): Promise<ReferenceNumberMutationResult> {
  const value = normalizeReferenceValue(rawValue);
  if (!value) {
    return { ok: false, error: `Enter a value of ${REFERENCE_VALUE_MAX} characters or fewer.` };
  }

  const type = referenceType.trim();
  if (!type) {
    return { ok: false, error: "Enter a reference type." };
  }

  const resolved = await resolveTaiShipmentId(shipmentId);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  const result = await updateShipmentReferenceNumbers(
    resolved.taiShipmentId,
    [{ referenceType: type, value }],
    { shipmentId, attempt: 1 },
  );

  if (!result.ok) {
    // The raw TAI error stays in `tai_api_calls`; the operator gets the outcome.
    return { ok: false, error: "TAI rejected the reference number. It has not been saved." };
  }

  return { ok: true };
}

export async function deleteReferenceNumber(
  shipmentId: string,
  referenceType: string,
): Promise<ReferenceNumberMutationResult> {
  const type = referenceType.trim();
  if (!type) {
    return { ok: false, error: "Enter a reference type." };
  }

  const resolved = await resolveTaiShipmentId(shipmentId);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  const result = await deleteShipmentReferenceNumbers(
    resolved.taiShipmentId,
    [{ referenceType: type }],
    { shipmentId, attempt: 1 },
  );

  if (!result.ok) {
    return { ok: false, error: "TAI rejected the delete. The reference number is unchanged." };
  }

  return { ok: true };
}
