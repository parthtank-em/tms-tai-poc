"use client";

import { useActionState, useState } from "react";

import { lookupCarrierAction, type CarrierLookupState } from "./actions";
import { InsuranceResult } from "./insurance-result";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FmcsaCarrier } from "@/lib/fmcsa/client";

const INITIAL: CarrierLookupState = { status: "idle" };

/** Pre-filled so the page is one click from a working lookup. */
const DEFAULT_DOT_NUMBER = "44110";

/** FMCSA omits any element with no value, so a gap here is normal. */
const EMPTY = "—";

/** One line per address part, skipping the parts FMCSA did not return. */
function formatAddress(carrier: FmcsaCarrier): string | null {
  const locality = [carrier.phyCity, carrier.phyState, carrier.phyZip].filter(Boolean).join(", ");
  const lines = [carrier.phyStreet, locality, carrier.phyCountry].filter(Boolean);

  return lines.length > 0 ? lines.join("\n") : null;
}

function carrierFields(carrier: FmcsaCarrier): [label: string, value: string | null][] {
  return [
    ["Company Legal Name", carrier.legalName],
    ["Company DBA Name", carrier.dbaName],
    ["Business AIN (Tax ID)", carrier.businessAin],
    ["Business Type", carrier.businessType],
    ["Physical Address", formatAddress(carrier)],
    ["Allowed to operate", carrier.allowToOperate],
    ["Out of service", carrier.outOfService],
  ];
}

function CarrierResult({
  carrier,
  raw,
  retrievalDate,
}: {
  carrier: FmcsaCarrier;
  raw: unknown;
  retrievalDate: string | null;
}) {
  return (
    <Card>
      <CardContent className="space-y-6">
        <dl className="divide-y">
          {carrierFields(carrier).map(([label, fieldValue]) => (
            <div key={label} className="grid gap-0.5 py-2.5 sm:grid-cols-[15rem_1fr] sm:gap-4">
              <dt className="text-muted-foreground">{label}</dt>
              {/* Only the address is multi-line; the rest collapse to one. */}
              <dd className="whitespace-pre-line">{fieldValue ?? EMPTY}</dd>
            </div>
          ))}
        </dl>

        {/*
          FMCSA returns more elements than the list above names, and which ones
          arrive varies by carrier. Keeping the raw body one click away means a
          missing field can be checked without re-running the call.
        */}
        <Accordion>
          <AccordionItem value="raw">
            <AccordionTrigger>Raw response</AccordionTrigger>
            <AccordionContent>
              <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs">
                {JSON.stringify(raw, null, 2)}
              </pre>
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        {retrievalDate && (
          <p className="text-xs text-muted-foreground">Retrieved from FMCSA: {retrievalDate}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function CarrierLookup() {
  const [state, formAction, pending] = useActionState(lookupCarrierAction, INITIAL);

  // React resets the form once the action settles. Holding the number keeps a
  // failed lookup from making the operator retype it.
  const [dotNumber, setDotNumber] = useState(DEFAULT_DOT_NUMBER);

  const failure = state.status === "done" && !state.result.ok ? state.result : null;

  return (
    <div className="space-y-8">
      <form action={formAction} className="space-y-1.5">
        <Label htmlFor="dotNumber">US DOT Number</Label>

        {/* The buttons share this row so the hint below only follows the input. */}
        <div className="flex flex-wrap items-center gap-3">
          <Input
            id="dotNumber"
            name="dotNumber"
            value={dotNumber}
            onChange={(event) => setDotNumber(event.target.value)}
            // A numeric keypad on mobile, but still a text field: `type=number`
            // brings spinners and silently drops a pasted value with a stray
            // character instead of letting the server explain the problem.
            inputMode="numeric"
            autoComplete="off"
            placeholder="Enter US DOT Number"
            required
            autoFocus
            disabled={pending}
            aria-invalid={failure?.failure === "invalid-dot" || undefined}
            aria-describedby={failure ? "dot-hint lookup-error" : "dot-hint"}
            className="h-9 w-56"
          />

          <Button type="submit" size="lg" disabled={pending}>
            {pending ? "Fetching…" : "Fetch"}
          </Button>

          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => setDotNumber("")}
            disabled={pending || dotNumber === ""}
          >
            Clear
          </Button>
        </div>

        <p id="dot-hint" className="text-xs text-muted-foreground">
          (Ex. 44110)
        </p>
      </form>

      {failure && (
        <p id="lookup-error" role="alert" aria-live="polite" className="text-sm text-destructive">
          {failure.message}
        </p>
      )}

      {state.status === "done" && state.result.ok && (
        <CarrierResult
          carrier={state.result.carrier}
          raw={state.result.raw}
          retrievalDate={state.result.retrievalDate}
        />
      )}

      {/*
        The filings come from the open-data portal rather than QCMobile, so they
        need no webKey and are shown whenever the number itself was usable —
        including when the carrier call failed for a reason of its own.
      */}
      {state.status === "done" &&
        !(state.insurance.ok === false && state.insurance.failure === "invalid-dot") && (
          <InsuranceResult result={state.insurance} />
        )}
    </div>
  );
}
