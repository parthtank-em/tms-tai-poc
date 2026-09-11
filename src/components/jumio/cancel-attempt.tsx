"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Release an attempt stuck at `INITIATED`.
 *
 * Shown wherever a verification is still sitting in that state: the driver
 * closed the capture screens before Jumio saw anything, so nothing will ever
 * move the row on its own, and it blocks the next attempt until the token
 * expires. The server refuses anything further along, so this cannot abandon a
 * journey the driver is actually in the middle of.
 */
export function CancelAttempt({
  verificationId,
  driverId,
  label = "Cancel this attempt",
}: {
  verificationId: string;
  driverId: string;
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function cancel() {
    setBusy(true);

    try {
      await fetch("/api/jumio/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verificationId }),
      });
    } catch {
      // Navigating anyway: the driver page re-reads the row and will show
      // whatever actually happened.
    }

    router.push(`/jumio-dashboard/drivers/${driverId}`);
  }

  return (
    <Button variant="outline" onClick={cancel} disabled={busy}>
      {busy ? "Cancelling…" : label}
    </Button>
  );
}
