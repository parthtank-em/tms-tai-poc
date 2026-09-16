"use client";

import { useState, useTransition } from "react";

import { fetchDriver, saveDriverAction, type DriverState } from "./reference-number-actions";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DRIVER_NAME_REFERENCE_TYPE,
  DRIVER_PHONE_REFERENCE_TYPE,
  EMPTY_DRIVER,
  REFERENCE_VALUE_MAX,
  driverFieldsEqual,
  normalizeDriverFields,
  type DriverFields,
} from "@/lib/tai/reference-types";

export function ReferenceNumbersDialog({ shipmentId }: { shipmentId: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DriverState | null>(null);
  const [draft, setDraft] = useState<DriverFields>(EMPTY_DRIVER);
  const [pending, startTransition] = useTransition();
  const [busyKind, setBusyKind] = useState<"load" | "save" | null>(null);

  // Same shape as the alerts dialog: every path is an event handler. Each action
  // returns the driver as TAI now holds it, and the inputs follow that — so what
  // is on screen after a load or a save is what was really stored, not what was
  // typed. A failed save is the one case the two differ, and there the error
  // beside the field says so.
  function run(kind: "load" | "save", work: () => Promise<DriverState>) {
    setBusyKind(kind);
    startTransition(async () => {
      try {
        const next = await work();
        setState(next);
        setDraft(next.driver);
      } catch (cause) {
        setState({
          driver: state?.driver ?? EMPTY_DRIVER,
          error: cause instanceof Error ? cause.message : "Something went wrong.",
        });
      } finally {
        setBusyKind(null);
      }
    });
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;

    // Reopening re-reads: TAI is the only copy, and it may have moved on since
    // the dialog was last closed.
    setState(null);
    setDraft(EMPTY_DRIVER);
    run("load", () => fetchDriver(shipmentId));
  }

  const loaded = state !== null;
  const busy = pending;

  // Nothing to save until an input differs from what TAI returned. Comparing
  // normalized values keeps a stray space from counting as an edit.
  const dirty =
    loaded && !driverFieldsEqual(normalizeDriverFields(draft), normalizeDriverFields(state.driver));

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            Add driver
          </Button>
        }
      />

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add driver</DialogTitle>
          <DialogDescription>
            The driver for this shipment, as TAI holds it. TAI stores these as shipment
            reference numbers; saving writes straight to TAI, and clearing a field removes it.
          </DialogDescription>
        </DialogHeader>

        <form
          action={(formData) => {
            run("save", () => saveDriverAction(formData));
          }}
          className="space-y-4"
        >
          <input type="hidden" name="shipmentId" value={shipmentId} />

          <div className="space-y-2">
            <Label htmlFor="driverName">{DRIVER_NAME_REFERENCE_TYPE}</Label>
            <Input
              id="driverName"
              name="name"
              className="h-9"
              placeholder={loaded ? "Enter driver name" : "Loading…"}
              maxLength={REFERENCE_VALUE_MAX}
              value={draft.name}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
              disabled={busy || !loaded}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="driverPhone">{DRIVER_PHONE_REFERENCE_TYPE}</Label>
            <Input
              id="driverPhone"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              className="h-9"
              placeholder={loaded ? "Enter driver phone number" : "Loading…"}
              maxLength={REFERENCE_VALUE_MAX}
              value={draft.phone}
              onChange={(event) => setDraft((prev) => ({ ...prev, phone: event.target.value }))}
              disabled={busy || !loaded}
            />
          </div>

          {state?.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDraft(state?.driver ?? EMPTY_DRIVER)}
              disabled={busy || !dirty}
            >
              Reset
            </Button>

            <Button type="submit" disabled={busy || !dirty}>
              {busyKind === "save" ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
