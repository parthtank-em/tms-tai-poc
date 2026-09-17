"use client";

import { MoreHorizontalIcon } from "lucide-react";
import { createContext, useContext, useState, useTransition, type ReactNode } from "react";

import {
  assignDriverAction,
  capturePodAction,
  setStatusAction,
  stopArrivalAction,
  stopDepartureAction,
  updateAppointmentAction,
  verifyDriverAction,
  type ActionState,
} from "./lifecycle-actions";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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

/** All ten statuses, in lifecycle order, labelled as TAI labels them. */
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "QUOTE", label: "Quote" },
  { value: "COMMITTED", label: "Committed" },
  { value: "READY", label: "Ready" },
  { value: "SENT", label: "Sent" },
  { value: "DISPATCHED", label: "Dispatched" },
  { value: "IN_TRANSIT", label: "In Transit" },
  { value: "OUT_FOR_DELIVERY", label: "Out for Delivery" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "COMPLETE", label: "Complete" },
  { value: "CANCELED", label: "Canceled" },
];

export function StatusControls({
  shipmentId,
  status,
}: {
  shipmentId: string;
  status: string;
}) {
  const { pending, run } = useFeedback();
  const [next, setNext] = useState<string | null>(null);

  return (
    <form
      action={(formData) => {
        run(async () => {
          const result = await setStatusAction(formData);
          if (!result.error) setNext(null);
          return result;
        });
      }}
      className="flex items-center gap-2"
    >
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <input type="hidden" name="status" value={next ?? ""} />

      <Select value={next} onValueChange={(value) => setNext(value as string | null)}>
        <SelectTrigger size="sm" className="w-44" disabled={pending}>
          <SelectValue placeholder="Set status…" />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.value === status}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        type="submit"
        size="sm"
        disabled={pending || !next || next === status}
        title="Update the shipment status"
      >
        Update
      </Button>
    </form>
  );
}

export function StopControls({
  shipmentId,
  stopId,
  isPickup,
  isDelivery,
  hasArrived,
  hasDeparted,
  canSync,
  windowStart,
  windowEnd,
}: {
  shipmentId: string;
  stopId: string;
  isPickup: boolean;
  isDelivery: boolean;
  hasArrived: boolean;
  hasDeparted: boolean;
  canSync: boolean;
  windowStart: string | null;
  windowEnd: string | null;
}) {
  const { pending, run } = useFeedback();

  // The dialogs live here rather than inside menu items: the menu closes on
  // select, which would unmount a dialog nested inside it.
  const [podOpen, setPodOpen] = useState(false);
  const [apptOpen, setApptOpen] = useState(false);

  /** The simple actions need no form — just the two ids. */
  function submit(action: (formData: FormData) => Promise<ActionState>) {
    const formData = new FormData();
    formData.set("shipmentId", shipmentId);
    formData.set("stopId", stopId);
    run(() => action(formData));
  }

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={pending || !canSync}
              aria-label="Stop actions"
              title={canSync ? "Stop actions" : "This stop is not ready to update yet"}
            >
              <MoreHorizontalIcon />
            </Button>
          }
        />

        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={hasArrived} onClick={() => submit(stopArrivalAction)}>
            Record arrival
          </DropdownMenuItem>

          {isPickup ? (
            <DropdownMenuItem
              disabled={!hasArrived || hasDeparted}
              onClick={() => submit(stopDepartureAction)}
            >
              Record departure
            </DropdownMenuItem>
          ) : null}

          {isDelivery ? (
            <DropdownMenuItem onClick={() => setPodOpen(true)}>
              Capture proof of delivery
            </DropdownMenuItem>
          ) : null}

          <DropdownMenuItem onClick={() => setApptOpen(true)}>
            Set appointment window
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <PodDialog
        shipmentId={shipmentId}
        stopId={stopId}
        open={podOpen}
        onOpenChange={setPodOpen}
      />
      <AppointmentDialog
        shipmentId={shipmentId}
        stopId={stopId}
        open={apptOpen}
        onOpenChange={setApptOpen}
        windowStart={windowStart}
        windowEnd={windowEnd}
      />
    </div>
  );
}

function PodDialog({
  shipmentId,
  stopId,
  open,
  onOpenChange,
}: {
  shipmentId: string;
  stopId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { pending, run } = useFeedback();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Capture proof of delivery</DialogTitle>
          <DialogDescription>Who signed for this delivery?</DialogDescription>
        </DialogHeader>

        <form
          action={(formData) => {
            run(async () => {
              const result = await capturePodAction(formData);
              if (!result.error) onOpenChange(false);
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

function AppointmentDialog({
  shipmentId,
  stopId,
  open,
  onOpenChange,
  windowStart,
  windowEnd,
}: {
  shipmentId: string;
  stopId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  windowStart: string | null;
  windowEnd: string | null;
}) {
  const { pending, run } = useFeedback();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Appointment window</DialogTitle>
          <DialogDescription>
            The scheduled window for this stop. All times are UTC.
          </DialogDescription>
        </DialogHeader>

        <form
          action={(formData) => {
            run(async () => {
              const result = await updateAppointmentAction(formData);
              if (!result.error) onOpenChange(false);
              return result;
            });
          }}
          className="space-y-3"
        >
          <input type="hidden" name="shipmentId" value={shipmentId} />
          <input type="hidden" name="stopId" value={stopId} />

          <div className="space-y-2">
            <Label htmlFor="appointmentBegin">Begins</Label>
            <Input
              id="appointmentBegin"
              name="appointmentBegin"
              type="datetime-local"
              defaultValue={windowStart ?? ""}
              required
              className="h-9"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="appointmentEnd">Ends (optional)</Label>
            <Input
              id="appointmentEnd"
              name="appointmentEnd"
              type="datetime-local"
              defaultValue={windowEnd ?? ""}
              className="h-9"
            />
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" size="sm" />}>
              Cancel
            </DialogClose>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save"}
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
            The driver assigned to this shipment. Verifying their identity is a separate step.
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
            title="Record that the driver's identity was verified"
          >
            {verified ? "Identity verified" : "Verify identity"}
          </ActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
