"use client";

import { useCallback, useState } from "react";

import { JumioWebSdk } from "./web-sdk";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import type { JumioAcquisition } from "@/lib/jumio/acquisition";

/**
 * Pickup verification — one live selfie, checked against the driver's
 * registration.
 *
 * Three steps in one modal: pick the driver, take the selfie, read the answer.
 * Nothing is written to the database; the transaction's identifiers live in
 * this component's state and are gone when the modal closes. That is enough to
 * demonstrate the check and deliberately not enough to release a shipment on.
 */

type SdkAcquisition = Extract<JumioAcquisition, { channel: "sdk" }>;

type Transaction = {
  accountId: string;
  workflowExecutionId: string;
  acquisition: SdkAcquisition;
};

type Result = {
  decision: string | null;
  riskScore: number | null;
  liveness: string | null;
  faceMatch: string | null;
  capabilities: Record<string, string>;
  completedAt: string | null;
  settled: boolean;
};

export type PickupDriver = { id: string; name: string };

function Row({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value ?? "—"}</dd>
    </div>
  );
}

export function PickupVerificationDialog({ drivers }: { drivers: PickupDriver[] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  function reset(next: boolean) {
    setOpen(next);
    if (next) return;
    setBusy(false);
    setError(null);
    setTransaction(null);
    setResult(null);
  }

  async function start(driverId: string) {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/jumio/pickup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driverId }),
      });

      const payload = (await response.json()) as Partial<Transaction> & { error?: string };

      if (!response.ok || !payload.acquisition || !payload.accountId || !payload.workflowExecutionId) {
        setError(payload.error ?? "Could not start pickup verification.");
        return;
      }

      setTransaction(payload as Transaction);
    } catch {
      setError("Could not reach FreightID. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  // Stable identity, or JumioWebSdk rebuilds itself and drops the camera.
  const onDone = useCallback(() => {
    if (!transaction) return;

    setBusy(true);
    setTransaction(null);

    const query = new URLSearchParams({
      accountId: transaction.accountId,
      workflowExecutionId: transaction.workflowExecutionId,
    });

    fetch(`/api/jumio/pickup/result?${query}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as Result & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Retrieval failed.");
        setResult(payload);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not read the result.");
      })
      .finally(() => setBusy(false));
  }, [transaction]);

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            Pickup verification
          </Button>
        }
      />

      <DialogContent className={transaction ? "sm:max-w-2xl" : "sm:max-w-md"}>
        <DialogHeader>
          <DialogTitle>Pickup verification</DialogTitle>
          <DialogDescription>
            {transaction
              ? "Take a live selfie. Jumio compares it to the face captured at registration."
              : result
                ? "Jumio's answer. Nothing here is stored."
                : "Choose the driver collecting the shipment."}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {/* 1 — the selfie */}
        {transaction && (
          <div className="h-[60vh]">
            <JumioWebSdk
              token={transaction.acquisition.token}
              datacenter={transaction.acquisition.datacenter}
              locale={transaction.acquisition.locale}
              onDone={onDone}
            />
          </div>
        )}

        {/* 2 — the answer */}
        {result && (
          <div className="space-y-4">
            <dl className="divide-y">
              <Row label="Decision" value={result.decision} />
              <Row label="Risk score" value={result.riskScore} />
              <Row label="Liveness" value={result.liveness} />
              <Row label="Face match" value={result.faceMatch} />
              <Row label="Completed" value={result.completedAt} />
            </dl>

            {Object.keys(result.capabilities).length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium">Capabilities</p>
                <dl className="divide-y">
                  {Object.entries(result.capabilities).map(([name, label]) => (
                    <Row key={name} label={name} value={label} />
                  ))}
                </dl>
              </div>
            )}

            {!result.settled && (
              <p className="text-sm text-muted-foreground">
                Jumio is still processing — this is what it says so far.
              </p>
            )}
          </div>
        )}

        {/* 3 — the driver picker, which is also where a failure lands back */}
        {!transaction && !result && (
          <div className="space-y-2">
            {drivers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No driver has a passed identity verification yet. Registration has to succeed
                before a pickup check has a face to compare against.
              </p>
            ) : (
              drivers.map((driver) => (
                <Button
                  key={driver.id}
                  variant="outline"
                  className="w-full justify-start"
                  disabled={busy}
                  onClick={() => start(driver.id)}
                >
                  {driver.name}
                </Button>
              ))
            )}
          </div>
        )}

        {busy && !transaction && <p className="text-sm text-muted-foreground">Working…</p>}
      </DialogContent>
    </Dialog>
  );
}
