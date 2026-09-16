"use server";

import { requireSession } from "@/lib/auth/guard";
import { getDriver, saveDriver } from "@/lib/tai/reference-numbers";
import type { DriverFields } from "@/lib/tai/reference-types";

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
 */
export async function saveDriverAction(formData: FormData): Promise<DriverState> {
  await requireSession();

  const shipmentId = String(formData.get("shipmentId") ?? "");

  const result = await saveDriver(shipmentId, {
    name: String(formData.get("name") ?? ""),
    phone: String(formData.get("phone") ?? ""),
  });

  return stateAfter(shipmentId, result.ok ? null : result.error);
}
