"use client";

import { createContext, useContext, useState, useTransition, type ReactNode } from "react";

import {
  assignDriverAction,
  capturePodAction,
  setStatusAction,
  stopArrivalAction,
  stopDepartureAction,
  verifyDriverAction,
  type ActionState,
} from "./lifecycle-actions";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Inline lifecycle controls for use case 3.
 *
 * Every button posts a Server Action that writes locally and queues the TAI
 * push. The page is revalidated afterwards, so the Stops table and event
 * history reflect the new state without any client-side cache to keep in sync.
 */

type Feedback = { pending: boolean; run: (work: () => Promise<ActionState>) => void };

const FeedbackContext = createContext<Feedback | null>(null);

export function LifecycleFeedback({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ActionState>({ error: null, notice: null });
  const [pending, startTransition] = useTransition();

  function run(work: () => Promise<ActionState>) {
    startTransition(async () => {
      try {
        setState(await work());
      } catch (cause) {
        setState({
          error: cause instanceof Error ? cause.message : "Something went wrong.",
          notice: null,
        });
      }
    });
  }

  return (
    <FeedbackContext.Provider value={{ pending, run }}>
      {state.error ? (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          {state.notice}
        </p>
      ) : null}
      {children}
    </FeedbackContext.Provider>
  );
}

function useFeedback(): Feedback {
  const context = useContext(FeedbackContext);
  if (!context) throw new Error("Lifecycle controls must sit inside <LifecycleFeedback>.");
  return context;
}

/** A button whose whole job is to submit one Server Action with fixed fields. */
function ActionButton({
  fields,
  action,
  children,
  variant = "outline",
  disabled,
  title,
}: {
  fields: Record<string, string>;
  action: (formData: FormData) => Promise<ActionState>;
  children: ReactNode;
  variant?: "outline" | "default" | "secondary" | "ghost";
  disabled?: boolean;
  title?: string;
}) {
  const { pending, run } = useFeedback();

  return (
    <form
      action={(formData) => {
        run(() => action(formData));
      }}
      className="inline"
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button
        type="submit"
        size="sm"
        variant={variant}
        disabled={pending || disabled}
        title={title}
      >
        {children}
      </Button>
    </form>
  );
}

export function StatusControls({
  shipmentId,
  status,
}: {
  shipmentId: string;
  status: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <ActionButton
        fields={{ shipmentId, status: "IN_TRANSIT" }}
        action={setStatusAction}
        disabled={status === "IN_TRANSIT"}
        title="PUT /Tracking · shipmentStatus: In Transit"
      >
        In transit
      </ActionButton>
      <ActionButton
        fields={{ shipmentId, status: "DELIVERED" }}
        action={setStatusAction}
        disabled={status === "DELIVERED"}
        title="PUT /Tracking · shipmentStatus: Delivered"
      >
        Delivered
      </ActionButton>
    </div>
  );
}

export function StopControls({
  shipmentId,
  stopId,
  stopType,
  hasArrived,
  hasDeparted,
  canSync,
}: {
  shipmentId: string;
  stopId: string;
  stopType: string;
  hasArrived: boolean;
  hasDeparted: boolean;
  canSync: boolean;
}) {
  const blocked = canSync ? undefined : "No TAI stop ID on this stop yet";

  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      <ActionButton
        fields={{ shipmentId, stopId }}
        action={stopArrivalAction}
        disabled={hasArrived || !canSync}
        title={blocked ?? "PUT /Tracking/{shipmentStopId}"}
      >
        Arrived
      </ActionButton>

      {stopType === "DELIVERY" ? (
        <PodDialog shipmentId={shipmentId} stopId={stopId} canSync={canSync} />
      ) : (
        <ActionButton
          fields={{ shipmentId, stopId }}
          action={stopDepartureAction}
          disabled={!hasArrived || hasDeparted || !canSync}
          title={blocked ?? "PUT /Tracking/{shipmentStopId}"}
        >
          Departed
        </ActionButton>
      )}
    </div>
  );
}

function PodDialog({
  shipmentId,
  stopId,
  canSync,
}: {
  shipmentId: string;
  stopId: string;
  canSync: boolean;
}) {
  const { pending, run } = useFeedback();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline" disabled={pending || !canSync}>
            POD
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Capture proof of delivery</DialogTitle>
          <DialogDescription>
            Records the signature locally and pushes it to TAI as
            <code className="mx-1 text-xs">proofOfDeliverySignedBy</code>.
          </DialogDescription>
        </DialogHeader>

        <form
          action={(formData) => {
            run(async () => {
              const result = await capturePodAction(formData);
              if (!result.error) setOpen(false);
              return result;
            });
          }}
          className="space-y-3"
        >
          <input type="hidden" name="shipmentId" value={shipmentId} />
          <input type="hidden" name="stopId" value={stopId} />

          <div className="space-y-2">
            <Label htmlFor="signedBy">Signed by</Label>
            <Input id="signedBy" name="signedBy" required autoFocus className="h-9" />
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" size="sm" />}>
              Cancel
            </DialogClose>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Capture"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DriverDialog({
  shipmentId,
  driverName,
  driverPhone,
  verified,
}: {
  shipmentId: string;
  driverName: string | null;
  driverPhone: string | null;
  verified: boolean;
}) {
  const { pending, run } = useFeedback();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            {driverName ? "Driver" : "Assign driver"}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Driver</DialogTitle>
          <DialogDescription>
            Assignment is recorded in FreightID only. TAI models drivers as shipment reference
            numbers and the write path is unconfirmed, so this is deliberately not pushed (§5).
            Identity verification is separate — that one does go to TAI.
          </DialogDescription>
        </DialogHeader>

        <form
          action={(formData) => {
            run(() => assignDriverAction(formData));
          }}
          className="space-y-3"
        >
          <input type="hidden" name="shipmentId" value={shipmentId} />

          <div className="space-y-2">
            <Label htmlFor="driverName">Name</Label>
            <Input
              id="driverName"
              name="driverName"
              defaultValue={driverName ?? ""}
              required
              className="h-9"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="driverPhone">Phone</Label>
            <Input
              id="driverPhone"
              name="driverPhone"
              defaultValue={driverPhone ?? ""}
              className="h-9"
            />
          </div>

          <Button type="submit" size="sm" disabled={pending} className="w-full">
            {driverName ? "Reassign" : "Assign"}
          </Button>
        </form>

        <DialogFooter className="border-t pt-3">
          <ActionButton
            fields={{ shipmentId }}
            action={verifyDriverAction}
            disabled={!driverName || verified}
            variant="secondary"
            title="POST /ShipmentActivityLogs"
          >
            {verified ? "Identity verified" : "Verify identity"}
          </ActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
