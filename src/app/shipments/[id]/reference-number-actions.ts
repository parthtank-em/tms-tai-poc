"use server";

import { requireSession } from "@/lib/auth/guard";
import {
  addReferenceNumber,
  deleteReferenceNumber,
  listReferenceNumbers,
} from "@/lib/tai/reference-numbers";
import { DRIVER_NAME_REFERENCE_TYPE, type ReferenceNumber } from "@/lib/tai/reference-types";

/**
 * Every action returns the whole list as TAI now holds it, so the dialog keeps
 * one piece of state and never has to reconcile a partial update. These calls
 * are synchronous against TAI — there is no local copy to fall back on, so a
 * failed write means nothing changed anywhere.
 *
 * Success carries no message: the returned list already shows the row appearing
 * or going. Only failure needs words.
 */
export type ReferenceNumbersState = {
  referenceNumbers: ReferenceNumber[];
  error: string | null;
};

async function stateAfter(
  shipmentId: string,
  writeError: string | null,
): Promise<ReferenceNumbersState> {
  const { referenceNumbers, error } = await listReferenceNumbers(shipmentId);

  // A write error is the more useful thing to say; a re-read error only
  // surfaces when the write itself went through.
  return { referenceNumbers, error: writeError ?? error };
}

export async function fetchReferenceNumbers(shipmentId: string): Promise<ReferenceNumbersState> {
  await requireSession();
  return stateAfter(shipmentId, null);
}

export async function addReferenceNumberAction(
  formData: FormData,
): Promise<ReferenceNumbersState> {
  await requireSession();

  const shipmentId = String(formData.get("shipmentId") ?? "");
  const referenceType = String(formData.get("referenceType") ?? DRIVER_NAME_REFERENCE_TYPE);
  const value = String(formData.get("value") ?? "");

  const result = await addReferenceNumber(shipmentId, referenceType, value);

  return stateAfter(shipmentId, result.ok ? null : result.error);
}

export async function deleteReferenceNumberAction(
  formData: FormData,
): Promise<ReferenceNumbersState> {
  await requireSession();

  const shipmentId = String(formData.get("shipmentId") ?? "");
  const referenceType = String(formData.get("referenceType") ?? "");

  const result = await deleteReferenceNumber(shipmentId, referenceType);

  return stateAfter(shipmentId, result.ok ? null : result.error);
}
