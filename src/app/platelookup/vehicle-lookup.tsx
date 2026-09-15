"use client";

import { useActionState, useState } from "react";

import { lookupVehicleAction, type VehicleLookupState } from "./actions";

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
import type { PlateLookupVehicle } from "@/lib/platelookup/client";

const INITIAL: VehicleLookupState = { status: "idle" };

/** Pre-filled so the page is one click from a working lookup. */
const DEFAULTS = { vin: "3GNCJLSBXLL230525", state: "VA", plate: "9247DG" };

/**
 * Keeps the "or" separator and the buttons on the inputs' line: with the
 * example hints below each field, bottom-aligning the row would otherwise drop
 * them to the hints' baseline. Matches the hint's line height (`text-xs`, 1rem)
 * plus the `space-y-1.5` gap above it.
 */
const ALIGN_TO_INPUT = "mb-[1.375rem]";

/** The API fills in what it has, so a gap here is normal. */
const EMPTY = "—";

function vehicleFields(vehicle: PlateLookupVehicle): [label: string, value: string | null][] {
  return [
    ["VIN", vehicle.vin],
    ["Make", vehicle.make],
    ["Model", vehicle.model],
    ["Year", vehicle.year],
    ["Trim", vehicle.trim],
    ["Body Type", vehicle.bodyType],
    ["Engine", vehicle.engine],
    ["Drivetrain", vehicle.drivetrain],
    ["Cylinders", vehicle.cylinders],
    ["Fuel Type", vehicle.fuelType],
    ["Seating Capacity", vehicle.seatingCapacity],
    ["Base MSRP", vehicle.baseMsrp],
    ["Manufactured In", vehicle.manufacturedIn],
  ];
}

function FieldList({ rows }: { rows: [label: string, value: string | null][] }) {
  return (
    <dl className="divide-y">
      {rows.map(([label, value]) => (
        <div key={label} className="grid gap-0.5 py-2.5 sm:grid-cols-[15rem_1fr] sm:gap-4">
          <dt className="text-muted-foreground">{label}</dt>
          <dd>{value ?? EMPTY}</dd>
        </div>
      ))}
    </dl>
  );
}

function VehicleResult({ vehicle, raw }: { vehicle: PlateLookupVehicle; raw: unknown }) {
  return (
    <Card>
      <CardContent className="space-y-6">
        <FieldList rows={vehicleFields(vehicle)} />

        {/*
          `/v3/history` also returns owners, titles, accidents, auctions and
          recalls. The API PDF names those DTOs without giving their fields, so
          they stay in the raw panel rather than being rendered against guessed
          key names.
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
      </CardContent>
    </Card>
  );
}

export function VehicleLookup() {
  const [state, formAction, pending] = useActionState(lookupVehicleAction, INITIAL);

  // React resets the form once the action settles. Holding the inputs keeps a
  // failed lookup from making the operator retype them.
  const [vin, setVin] = useState(DEFAULTS.vin);
  const [plateState, setPlateState] = useState(DEFAULTS.state);
  const [plate, setPlate] = useState(DEFAULTS.plate);

  const failure = state.status === "done" && !state.result.ok ? state.result : null;
  const invalid = failure?.failure === "invalid-query" || failure?.failure === "bad-request";
  const empty = vin === "" && plateState === "" && plate === "";

  function clear() {
    setVin("");
    setPlateState("");
    setPlate("");
  }

  return (
    <div className="space-y-8">
      <form action={formAction} className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="vin">VIN</Label>
            <Input
              id="vin"
              name="vin"
              value={vin}
              onChange={(event) => setVin(event.target.value)}
              autoComplete="off"
              placeholder="Enter VIN"
              maxLength={17}
              autoFocus
              disabled={pending}
              aria-invalid={invalid || undefined}
              aria-describedby={failure ? "vin-hint lookup-error" : "vin-hint lookup-hint"}
              className="h-9 w-64 uppercase"
            />
            <p id="vin-hint" className="text-xs text-muted-foreground">
              (Ex. 3GNCJLSBXLL230525)
            </p>
          </div>

          {/*
            The two ways to identify a vehicle are alternatives, not a single
            three-part form. `h-9` matches the inputs so "or" sits on their line
            rather than on the labels above them.
          */}
          <span
            className={`flex h-9 items-center px-1 text-sm text-muted-foreground ${ALIGN_TO_INPUT}`}
          >
            or
          </span>

          <div className="space-y-1.5">
            <Label htmlFor="state">State</Label>
            <Input
              id="state"
              name="state"
              value={plateState}
              onChange={(event) => setPlateState(event.target.value)}
              autoComplete="off"
              placeholder="Enter State"
              maxLength={2}
              disabled={pending}
              aria-invalid={invalid || undefined}
              aria-describedby={failure ? "state-hint lookup-error" : "state-hint lookup-hint"}
              className="h-9 w-24 uppercase"
            />
            <p id="state-hint" className="text-xs text-muted-foreground">
              (Ex. VA)
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="plate">Plate</Label>
            <Input
              id="plate"
              name="plate"
              value={plate}
              onChange={(event) => setPlate(event.target.value)}
              autoComplete="off"
              placeholder="Enter License Plate"
              disabled={pending}
              aria-invalid={invalid || undefined}
              aria-describedby={failure ? "plate-hint lookup-error" : "plate-hint lookup-hint"}
              className="h-9 w-44 uppercase"
            />
            <p id="plate-hint" className="text-xs text-muted-foreground">
              (Ex. 9247DG)
            </p>
          </div>

          <div className={`flex gap-3 ${ALIGN_TO_INPUT}`}>
            <Button type="submit" size="lg" disabled={pending}>
              {pending ? "Fetching…" : "Fetch"}
            </Button>

            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={clear}
              disabled={pending || empty}
            >
              Clear
            </Button>
          </div>
        </div>

        {/*
          The "or" separator is visual only — it sits between fields, so a
          screen reader moving field to field never reaches it. Every input
          points here instead, which is also where the plate/state pairing rule
          is spelled out.
        */}
        <p id="lookup-hint" className="text-xs text-muted-foreground">
          Enter a VIN, or a state and plate together. Either identifies the vehicle on its own.
        </p>
      </form>

      {failure && (
        <p id="lookup-error" role="alert" aria-live="polite" className="text-sm text-destructive">
          {failure.message}
        </p>
      )}

      {state.status === "done" && state.result.ok && (
        <VehicleResult vehicle={state.result.vehicle} raw={state.result.raw} />
      )}
    </div>
  );
}
