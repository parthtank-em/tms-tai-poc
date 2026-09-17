"use server";

import { lookupCarrier, type FmcsaLookupResult } from "@/lib/fmcsa/client";
import { lookupInsurance, type FmcsaInsuranceResult } from "@/lib/fmcsa/insurance";
import { requireSession } from "@/lib/auth/guard";

/**
 * Only async functions may be exported from a "use server" file, so the initial
 * value lives with the component that seeds `useActionState` — the type is
 * erased at compile time and can stay here next to the action that returns it.
 */
export type CarrierLookupState =
  | { status: "idle" }
  | {
      status: "done";
      dotNumber: string;
      result: FmcsaLookupResult;
      insurance: FmcsaInsuranceResult;
    };

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

  // Two unrelated services — QCMobile for the carrier, the open-data portal for
  // the insurance filings — so they run together and are reported separately.
  // Neither one failing should cost the operator the other's answer.
  const [result, insurance] = await Promise.all([
    lookupCarrier(dotNumber),
    lookupInsurance(dotNumber),
  ]);

  return { status: "done", dotNumber, result, insurance };
}
