"use server";

import { lookupVehicle, type PlateLookupResult } from "@/lib/platelookup/client";
import { requireSession } from "@/lib/auth/guard";

/**
 * Only async functions may be exported from a "use server" file, so the initial
 * value lives with the component that seeds `useActionState` — the type is
 * erased at compile time and can stay here next to the action that returns it.
 */
export type VehicleLookupState =
  | { status: "idle" }
  | { status: "done"; result: PlateLookupResult };

/**
 * Runs the lookup server-side so `PLATELOOKUP_API_KEY` stays out of the browser.
 *
 * Server actions are POST endpoints reachable by anyone who knows the id, so
 * the session is checked here too — the layout's check guards the render, not
 * this.
 */
export async function lookupVehicleAction(
  _previous: VehicleLookupState,
  formData: FormData,
): Promise<VehicleLookupState> {
  await requireSession("/platelookup");

  const result = await lookupVehicle({
    vin: String(formData.get("vin") ?? ""),
    state: String(formData.get("state") ?? ""),
    plate: String(formData.get("plate") ?? ""),
  });

  return { status: "done", result };
}
