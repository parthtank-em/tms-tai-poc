import {
  asReferenceNumbers,
  deleteShipmentReferenceNumbers,
  getShipmentReferenceNumbers,
  isValidTaiShipmentId,
  updateShipmentReferenceNumbers,
  type PublicApiShipmentReferenceNumberV2,
} from "./api-client";
import {
  DRIVER_FIELD_KEYS,
  DRIVER_FIELD_TYPES,
  REFERENCE_VALUE_MAX,
  normalizeDriverFields,
  referenceKey,
  toDriverFields,
  type DriverFields,
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
 * something to rely on). `saveDriver` is what turns a screen full of edited
 * inputs into those two calls.
 *
 * See `toReferenceNumbers` for the duplicate rows TAI returns on read.
 *
 * The types this POC writes are "Driver Name" and "Driver Cell Phone Number" —
 * the schema notes on `Shipment.driverId` record why: TAI models a driver as a
 * set of shipment reference numbers, not as an entity of its own.
 */

export type ReferenceNumbersResult = {
  referenceNumbers: ReferenceNumber[];
  error: string | null;
};

/** A read that failed yields an empty driver plus the reason — see `getDriver`. */
export type DriverResult = {
  driver: DriverFields;
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
 * It doubles every written type, not just the first: a later read of the same
 * shipment carrying a driver name and cell phone number came back as both pairs
 * duplicated around `Shipment Id`.
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

/** The driver as TAI currently holds it — the values the dialog's inputs show. */
export async function getDriver(shipmentId: string): Promise<DriverResult> {
  const { referenceNumbers, error } = await listReferenceNumbers(shipmentId);
  return { driver: toDriverFields(referenceNumbers), error };
}

/**
 * Writes the driver as the operator left the inputs.
 *
 * Only what changed is sent, so an untouched field is never rewritten — which
 * matters because TAI's behaviour on writing a type it already holds is
 * unverified (`api-client.ts` says why). A changed value is a delete followed
 * by an add rather than an overwrite, for the same reason. The current values
 * come from TAI rather than from the form, so a field someone else changed in
 * the meantime is compared against what is really stored.
 *
 * Deletes go first and in one call, adds follow in one call: clearing the name
 * while setting the email must not leave the delete of one riding on the
 * success of the other.
 */
export async function saveDriver(
  shipmentId: string,
  fields: DriverFields,
): Promise<ReferenceNumberMutationResult> {
  const next = normalizeDriverFields(fields);

  const tooLong = Object.values(next).some((value) => value.length > REFERENCE_VALUE_MAX);
  if (tooLong) {
    return { ok: false, error: `Enter values of ${REFERENCE_VALUE_MAX} characters or fewer.` };
  }

  const current = await getDriver(shipmentId);
  if (current.error) {
    return { ok: false, error: current.error };
  }

  const typesToDelete: string[] = [];
  const entriesToAdd: ReferenceNumber[] = [];

  for (const key of DRIVER_FIELD_KEYS) {
    const referenceType = DRIVER_FIELD_TYPES[key];
    const was = current.driver[key];
    const now = next[key];

    if (was === now) continue;

    // Cleared or changed: the old row goes first either way.
    if (was) typesToDelete.push(referenceType);
    if (now) entriesToAdd.push({ referenceType, value: now });
  }

  if (typesToDelete.length === 0 && entriesToAdd.length === 0) {
    return { ok: true };
  }

  const resolved = await resolveTaiShipmentId(shipmentId);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  if (typesToDelete.length > 0) {
    const deleted = await deleteShipmentReferenceNumbers(
      resolved.taiShipmentId,
      typesToDelete.map((referenceType) => ({ referenceType })),
      { shipmentId, attempt: 1 },
    );

    if (!deleted.ok) {
      // Nothing has been added yet, so the driver on TAI is untouched.
      return { ok: false, error: "TAI rejected the delete. The driver is unchanged." };
    }
  }

  if (entriesToAdd.length > 0) {
    const added = await updateShipmentReferenceNumbers(resolved.taiShipmentId, entriesToAdd, {
      shipmentId,
      attempt: 1,
    });

    if (!added.ok) {
      // The raw TAI error stays in `tai_api_calls`; the operator gets the
      // outcome. Any delete above has already gone through, which is why the
      // dialog re-reads instead of keeping what was typed.
      return { ok: false, error: "TAI rejected the driver. Check the values below and retry." };
    }
  }

  return { ok: true };
}
