"use client";

import { useActionState, useState } from "react";

import { lookupCarrierAction, type CarrierLookupState } from "./actions";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FmcsaCarrier } from "@/lib/fmcsa/client";

const INITIAL: CarrierLookupState = { status: "idle" };

/** Elements only appear when they have a value, so a gap is normal here. */
function value(text: string | number | null): string {
  if (text === null || text === "") return "—";
  return String(text);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/**
 * "Allowed to operate" is the one field an operator acts on, so it reads as a
 * badge rather than a Y/N buried in a list. An absent value is left blank
 * instead of being guessed either way.
 */
function OperatingBadge({ carrier }: { carrier: FmcsaCarrier }) {
  const allowed = carrier.allowToOperate?.toUpperCase();
  const outOfService = carrier.outOfService?.toUpperCase() === "Y";

  if (outOfService) {
    return <Badge variant="destructive">Out of service</Badge>;
  }

  if (allowed === "Y") return <Badge variant="secondary">Allowed to operate</Badge>;
  if (allowed === "N") return <Badge variant="destructive">Not allowed to operate</Badge>;

  return <Badge variant="outline">Operating status not reported</Badge>;
}

function CarrierAddress({ carrier }: { carrier: FmcsaCarrier }) {
  const locality = [carrier.phyCity, carrier.phyState, carrier.phyZip].filter(Boolean).join(", ");
  const lines = [carrier.phyStreet, locality, carrier.phyCountry].filter(Boolean);

  if (lines.length === 0) return <>—</>;

  return (
    <span className="whitespace-pre-line">{lines.join("\n")}</span>
  );
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
  const vehicles: [string, number | null][] = [
    ["Buses", carrier.busVehicle],
    ["Limousines", carrier.limoVehicle],
    ["Mini-buses", carrier.miniBusVehicle],
    ["Motorcoaches", carrier.motorCoachVehicle],
    ["Vans", carrier.vanVehicle],
    ["Passenger vehicles", carrier.passengerVehicle],
  ];

  const reportedVehicles = vehicles.filter(([, count]) => count !== null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">{value(carrier.legalName)}</CardTitle>
        <CardDescription>
          {carrier.dbaName ? `DBA ${carrier.dbaName} · ` : ""}
          USDOT {value(carrier.dotNumber)}
          {carrier.mcNumber ? ` · MC ${carrier.mcNumber}` : ""}
        </CardDescription>
        <div className="mt-2">
          <OperatingBadge carrier={carrier} />
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Physical address">
            <CarrierAddress carrier={carrier} />
          </Field>
          <Field label="Telephone">{value(carrier.telephone)}</Field>
          <Field label="Complaints">{value(carrier.complaintCount)}</Field>
          <Field label="Out of service">{value(carrier.outOfService)}</Field>
          <Field label="Out of service date">{value(carrier.outOfServiceDate)}</Field>
          <Field label="Allowed to operate">{value(carrier.allowToOperate)}</Field>
        </dl>

        {reportedVehicles.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">Fleet</h3>
            <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
              {reportedVehicles.map(([label, count]) => (
                <Field key={label} label={label}>
                  {value(count)}
                </Field>
              ))}
            </dl>
          </div>
        )}

        {/*
          FMCSA returns more elements than the summary above names, and which
          ones arrive varies by carrier. Keeping the raw body one click away
          means a missing field can be checked without re-running the call.
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
  const [dotNumber, setDotNumber] = useState("");

  const failure = state.status === "done" && !state.result.ok ? state.result : null;

  return (
    <div className="space-y-8">
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="dotNumber">US DOT Number</Label>
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
            placeholder="44110"
            required
            autoFocus
            disabled={pending}
            aria-invalid={failure?.failure === "invalid-dot" || undefined}
            aria-describedby={failure ? "lookup-error" : undefined}
            className="h-9 w-56"
          />
        </div>

        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Fetching…" : "Fetch"}
        </Button>
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
    </div>
  );
}
