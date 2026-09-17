"use server";

import { requireSession } from "@/lib/auth/guard";
import { getDriver, saveDriver } from "@/lib/tai/reference-numbers";
import {
  DRIVER_FIELD_KEYS,
  type DriverFields,
} from "@/lib/tai/reference-types";

/**
 * Both actions return the driver as TAI now holds it, so the dialog keeps one
 * piece of state and never has to reconcile a partial update. These calls are
 * synchronous against TAI — there is no local copy to fall back on, so a failed
 * write means nothing changed anywhere.
 *
 * Success carries no message: the inputs already show what was saved. Only
 * failure needs words.
 */
export type DriverState = {
  driver: DriverFields;
  error: string | null;
};

async function stateAfter(shipmentId: string, writeError: string | null): Promise<DriverState> {
  const { driver, error } = await getDriver(shipmentId);

  // A write error is the more useful thing to say; a re-read error only
  // surfaces when the write itself went through.
  return { driver, error: writeError ?? error };
}

export async function fetchDriver(shipmentId: string): Promise<DriverState> {
  await requireSession();
  return stateAfter(shipmentId, null);
}

/**
 * Saves whatever the inputs hold. An empty field means the driver does not have
 * one, so clearing a field and saving removes it from TAI — there is no
 * separate delete.
 *
 * The fields are read by the same list the dialog renders from, so an input
 * added there is picked up here without this function changing. A field the
 * form did not send reads as empty, which is what an absent input means.
 */
export async function saveDriverAction(formData: FormData): Promise<DriverState> {
  await requireSession();

  const shipmentId = String(formData.get("shipmentId") ?? "");

  const fields = Object.fromEntries(
    DRIVER_FIELD_KEYS.map((key) => [key, String(formData.get(key) ?? "")]),
  ) as DriverFields;

  const result = await saveDriver(shipmentId, fields);

  return stateAfter(shipmentId, result.ok ? null : result.error);
}
