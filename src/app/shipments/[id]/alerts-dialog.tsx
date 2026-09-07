"use client";

import { useRef, useState, useTransition } from "react";

import {
  createAlertAction,
  fetchAlerts,
  fetchAlertTypes,
  resolveAlertAction,
  type AlertsState,
  type AlertTypesState,
} from "./alert-actions";

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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { formatDateTime } from "@/lib/format";
import type { AlertListItem } from "@/lib/tai/alerts";

function SyncBadge({ alert }: { alert: AlertListItem }) {
  if (alert.syncStatus === "SYNCED") {
    return (
      <Badge variant="secondary">
        Synced{alert.taiAlertId === null ? "" : ` · TAI #${alert.taiAlertId}`}
      </Badge>
    );
  }

  if (alert.syncStatus === "FAILED") {
    return <Badge variant="destructive">Not sent to TAI</Badge>;
  }

  return <Badge variant="outline">Queued for TAI</Badge>;
}

function AlertRow({
  alert,
  shipmentId,
  onResolve,
  busy,
}: {
  alert: AlertListItem;
  shipmentId: string;
  onResolve: (formData: FormData) => void;
  busy: boolean;
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{alert.alertType}</span>
          <Badge variant={alert.resolved ? "secondary" : "destructive"}>
            {alert.resolved ? "Resolved" : "Open"}
          </Badge>
          <SyncBadge alert={alert} />
        </div>

        <p className="text-xs text-muted-foreground">
          Raised {formatDateTime(alert.createdAt)}
          {alert.resolvedAt ? ` · resolved ${formatDateTime(alert.resolvedAt)}` : ""}
          {alert.taiShipmentStopId === null ? "" : ` · TAI stop ${alert.taiShipmentStopId}`}
        </p>

        {alert.syncError ? (
          <p className="text-xs break-words text-destructive">{alert.syncError}</p>
        ) : null}
      </div>

      {alert.resolved ? null : (
        <form action={onResolve}>
          <input type="hidden" name="shipmentId" value={shipmentId} />
          <input type="hidden" name="alertId" value={alert.id} />
          <Button type="submit" variant="outline" size="sm" disabled={busy}>
            Resolve
          </Button>
        </form>
      )}
    </li>
  );
}

export function AlertsDialog({
  shipmentId,
  initialOpenCount,
}: {
  shipmentId: string;
  initialOpenCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AlertsState | null>(null);
  const [types, setTypes] = useState<AlertTypesState | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [busyKind, setBusyKind] = useState<"load" | "create" | "resolve" | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Every path is an event handler rather than an effect: the dialog opening,
  // a raise, a resolve. Each server action returns the whole list, so one piece
  // of state always holds the current truth.
  function run(kind: "load" | "create" | "resolve", work: () => Promise<AlertsState>) {
    setBusyKind(kind);
    startTransition(async () => {
      try {
        setState(await work());
      } catch (cause) {
        setState({
          alerts: state?.alerts ?? [],
          error: cause instanceof Error ? cause.message : "Something went wrong.",
          notice: null,
        });
      } finally {
        setBusyKind(null);
      }
    });
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;

    run("load", () => fetchAlerts(shipmentId));
    startTransition(async () => {
      setTypes(await fetchAlertTypes());
    });
  }

  const alerts = state?.alerts ?? [];
  const openAlerts = alerts.filter((alert) => !alert.resolved);
  const busy = pending;

  const typeOptions = types?.options ?? [];
  const typesPlaceholder =
    types === null
      ? "Loading types…"
      : typeOptions.length === 0
        ? "No alert types available"
        : "Select an alert type";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            Alerts
            {initialOpenCount > 0 ? (
              <Badge variant="destructive" className="ml-1.5">
                {initialOpenCount}
              </Badge>
            ) : null}
          </Button>
        }
      />

      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Security alerts</DialogTitle>
          <DialogDescription>
            Raised in FreightID, then pushed to TAI. An alert is recorded here first, so a TAI outage
            delays it rather than losing it.
          </DialogDescription>
        </DialogHeader>

        <form
          ref={formRef}
          action={(formData) => {
            run("create", async () => {
              const result = await createAlertAction(formData);
              if (!result.error) {
                formRef.current?.reset();
                setSelectedType(null);
              }
              return result;
            });
          }}
          className="space-y-2"
        >
          <input type="hidden" name="shipmentId" value={shipmentId} />
          {/* The value TAI expects is the type name itself, so the option value
              and its label are the same string. */}
          <input type="hidden" name="alertType" value={selectedType ?? ""} />

          <Label htmlFor="alertType-trigger">New alert</Label>
          <div className="flex gap-2">
            <Select
              value={selectedType}
              onValueChange={(value) => setSelectedType(value as string | null)}
            >
              <SelectTrigger
                id="alertType-trigger"
                className="h-9 flex-1"
                disabled={busy || typeOptions.length === 0}
              >
                <SelectValue placeholder={typesPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {typeOptions.map((option) => (
                  <SelectItem key={option.name} value={option.name}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button type="submit" size="lg" disabled={busy || !selectedType}>
              {busyKind === "create" ? "Raising…" : "Raise"}
            </Button>
          </div>

          {types?.error ? (
            <p className="text-xs text-destructive">
              Could not load alert types from TAI: {types.error}
            </p>
          ) : null}
        </form>

        {state?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
        {state?.notice ? (
          <p role="status" className="text-sm text-muted-foreground">
            {state.notice}
          </p>
        ) : null}

        <Separator />

        <div className="max-h-80 overflow-y-auto">
          {state === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading alerts…</p>
          ) : alerts.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No alerts on this shipment.
            </p>
          ) : (
            <ul className="divide-y">
              {alerts.map((alert) => (
                <AlertRow
                  key={alert.id}
                  alert={alert}
                  shipmentId={shipmentId}
                  busy={busy}
                  onResolve={(formData) => {
                    run("resolve", () => resolveAlertAction(formData));
                  }}
                />
              ))}
            </ul>
          )}
        </div>

        {alerts.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {openAlerts.length} open · {alerts.length - openAlerts.length} resolved
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
