"use client";

import { useState, useTransition } from "react";

import {
  assignStaffAction,
  fetchBrokerStaff,
  type AssignmentState,
  type StaffState,
} from "./assignment-actions";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function AssignmentDialog({ shipmentId }: { shipmentId: string }) {
  const [open, setOpen] = useState(false);
  const [staff, setStaff] = useState<StaffState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<AssignmentState | null>(null);
  const [pending, startTransition] = useTransition();

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;

    // Reset on each open: an assignment made a minute ago is not news, and a
    // stale error would read as a fresh failure.
    setState(null);
    setSelectedId(null);

    startTransition(async () => {
      setStaff(await fetchBrokerStaff());
    });
  }

  const options = staff?.options ?? [];
  const busy = pending;

  const selected = options.find((option) => String(option.id) === selectedId);

  const placeholder =
    staff === null
      ? "Loading staff…"
      : options.length === 0
        ? "No staff available"
        : "Select a staff member";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            Assignment
          </Button>
        }
      />

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign shipment</DialogTitle>
          <DialogDescription>
            Assign this shipment to a member of broker staff in TAI.
          </DialogDescription>
        </DialogHeader>

        <form
          action={(formData) => {
            startTransition(async () => {
              try {
                setState(await assignStaffAction(formData));
              } catch (cause) {
                setState({
                  error: cause instanceof Error ? cause.message : "Something went wrong.",
                  notice: null,
                });
              }
            });
          }}
          className="space-y-2"
        >
          <input type="hidden" name="shipmentId" value={shipmentId} />
          <input type="hidden" name="staffId" value={selectedId ?? ""} />
          {/* Sent along so the confirmation can name the person rather than
              echo an id back at the operator. */}
          <input type="hidden" name="staffName" value={selected?.label ?? ""} />

          <Label htmlFor="staff-trigger">Staff member</Label>
          <div className="flex gap-2">
            <Select
              value={selectedId}
              onValueChange={(value) => setSelectedId(value as string | null)}
            >
              <SelectTrigger
                id="staff-trigger"
                className="h-9 flex-1"
                disabled={busy || options.length === 0}
              >
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.id} value={String(option.id)}>
                    {option.detail ? `${option.label} — ${option.detail}` : option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button type="submit" size="lg" disabled={busy || !selectedId}>
              {busy ? "Assigning…" : "Assign"}
            </Button>
          </div>

          {staff?.error ? (
            <p className="text-xs text-destructive">
              Staff are unavailable right now. Try again in a moment.
            </p>
          ) : null}
        </form>

        {state?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
        {/* TAI has no endpoint to read assignments back, so unlike the other
            dialogs there is no list to reflect the change. This line is the
            only confirmation the operator gets. */}
        {state?.notice ? (
          <p role="status" className="text-sm text-muted-foreground">
            {state.notice}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
