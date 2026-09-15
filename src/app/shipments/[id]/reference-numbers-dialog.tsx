"use client";

import { useRef, useState, useTransition } from "react";

import {
  addReferenceNumberAction,
  deleteReferenceNumberAction,
  fetchReferenceNumbers,
  type ReferenceNumbersState,
} from "./reference-number-actions";

import { Badge } from "@/components/ui/badge";
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
import { Separator } from "@/components/ui/separator";
import {
  DRIVER_NAME_REFERENCE_TYPE,
  REFERENCE_VALUE_MAX,
  referenceKey,
  type ReferenceNumber,
} from "@/lib/tai/reference-types";

function ReferenceRow({
  referenceNumber,
  shipmentId,
  onDelete,
  busy,
}: {
  referenceNumber: ReferenceNumber;
  shipmentId: string;
  onDelete: (formData: FormData) => void;
  busy: boolean;
}) {
  const isDriverName = referenceNumber.referenceType === DRIVER_NAME_REFERENCE_TYPE;

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{referenceNumber.referenceType}</span>
          {isDriverName ? <Badge variant="secondary">Driver</Badge> : null}
        </div>
        <p className="text-sm break-words text-muted-foreground">
          {referenceNumber.value || "—"}
        </p>
      </div>

      {/* Only the type this screen owns is removable — the rest come from TAI's
          own workflows and are shown for context, not for editing here. */}
      {isDriverName ? (
        <form action={onDelete}>
          <input type="hidden" name="shipmentId" value={shipmentId} />
          <input type="hidden" name="referenceType" value={referenceNumber.referenceType} />
          <Button type="submit" variant="outline" size="sm" disabled={busy}>
            Remove
          </Button>
        </form>
      ) : null}
    </li>
  );
}

export function ReferenceNumbersDialog({ shipmentId }: { shipmentId: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ReferenceNumbersState | null>(null);
  const [pending, startTransition] = useTransition();
  const [busyKind, setBusyKind] = useState<"load" | "add" | "delete" | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Same shape as the alerts dialog: every path is an event handler, and each
  // action returns the whole list, so one piece of state holds the truth.
  function run(kind: "load" | "add" | "delete", work: () => Promise<ReferenceNumbersState>) {
    setBusyKind(kind);
    startTransition(async () => {
      try {
        setState(await work());
      } catch (cause) {
        setState({
          referenceNumbers: state?.referenceNumbers ?? [],
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

    run("load", () => fetchReferenceNumbers(shipmentId));
  }

  const referenceNumbers = state?.referenceNumbers ?? [];
  const busy = pending;

  // One driver per shipment: with one already on the list the form is closed
  // until it is removed. Until the first load lands the list is empty, so `busy`
  // is what keeps the form shut in the meantime rather than this.
  const driverAdded = referenceNumbers.some(
    (entry) => entry.referenceType === DRIVER_NAME_REFERENCE_TYPE,
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            Add driver
          </Button>
        }
      />

      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add driver</DialogTitle>
          {/* Says why the list below carries rows that are not drivers: the
              driver is one reference number among the shipment's others. */}
          <DialogDescription>
            Add the driver for this shipment. TAI stores it as a reference number, alongside
            the others listed below. Adding and removing write straight to TAI.
          </DialogDescription>
        </DialogHeader>

        <form
          ref={formRef}
          action={(formData) => {
            run("add", async () => {
              const result = await addReferenceNumberAction(formData);
              if (!result.error) {
                formRef.current?.reset();
              }
              return result;
            });
          }}
          className="space-y-2"
        >
          <input type="hidden" name="shipmentId" value={shipmentId} />
          {/* "Driver Name" is the one type this screen writes — TAI models a
              driver as a reference number rather than an entity. */}
          <input type="hidden" name="referenceType" value={DRIVER_NAME_REFERENCE_TYPE} />

          <Label htmlFor="referenceValue">{DRIVER_NAME_REFERENCE_TYPE}</Label>
          <div className="flex gap-2">
            <Input
              id="referenceValue"
              name="value"
              className="h-9 flex-1"
              placeholder="Enter driver name"
              maxLength={REFERENCE_VALUE_MAX}
              defaultValue=""
              disabled={busy || driverAdded}
              required
            />

            <Button type="submit" size="lg" disabled={busy || driverAdded}>
              {busyKind === "add" ? "Adding…" : "Add"}
            </Button>
          </div>
        </form>

        {state?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}

        <Separator />

        <div className="max-h-80 overflow-y-auto">
          {state === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Loading reference numbers…
            </p>
          ) : referenceNumbers.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No reference numbers on this shipment.
            </p>
          ) : (
            <ul className="divide-y">
              {referenceNumbers.map((referenceNumber) => (
                <ReferenceRow
                  key={referenceKey(referenceNumber)}
                  referenceNumber={referenceNumber}
                  shipmentId={shipmentId}
                  busy={busy}
                  onDelete={(formData) => {
                    run("delete", () => deleteReferenceNumberAction(formData));
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
