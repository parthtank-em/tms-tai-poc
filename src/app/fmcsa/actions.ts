"use server";

import { lookupCarrier, type FmcsaLookupResult } from "@/lib/fmcsa/client";
import { requireSession } from "@/lib/auth/guard";

/**
 * Only async functions may be exported from a "use server" file, so the initial
 * value lives with the component that seeds `useActionState` — the type is
 * erased at compile time and can stay here next to the action that returns it.
 */
export type CarrierLookupState =
  | { status: "idle" }
  | { status: "done"; dotNumber: string; result: FmcsaLookupResult };

/**
 * Runs the lookup server-side so `FMCSA_WEB_KEY` stays out of the browser.
 *
 * Server actions are POST endpoints reachable by anyone who knows the id, so
 * the session is checked here too — the layout's check guards the render, not
 * this.
 */
export async function lookupCarrierAction(
  _previous: CarrierLookupState,
  formData: FormData,
): Promise<CarrierLookupState> {
  await requireSession("/fmcsa");

  const dotNumber = String(formData.get("dotNumber") ?? "").trim();

  return { status: "done", dotNumber, result: await lookupCarrier(dotNumber) };
}
