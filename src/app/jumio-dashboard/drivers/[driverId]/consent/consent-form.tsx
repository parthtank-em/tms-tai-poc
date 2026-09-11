"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { JumioWebSdk } from "@/components/jumio/web-sdk";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import type { JumioAcquisition } from "@/lib/jumio/acquisition";

/**
 * Consent, then hand off to Jumio (§9, §10).
 *
 * The button is disabled until the box is ticked, and the API refuses the call
 * without `consent: true` as well — the server does not trust this component
 * to be the only way in.
 *
 * What happens next is the server's decision, carried in `acquisition`: the
 * SDK opens the capture screens over this page, or the browser navigates to
 * Jumio's hosted Web Client. Neither ending is a result — the driver lands on
 * the verification page, which reads the database.
 */

type StartResponse = {
  verificationId?: string;
  acquisition?: JumioAcquisition;
  error?: string;
};

type SdkAcquisition = Extract<JumioAcquisition, { channel: "sdk" }>;

export function ConsentForm({ driverId, driverName }: { driverId: string; driverName: string }) {
  const router = useRouter();
  const [consented, setConsented] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [sdk, setSdk] = useState<SdkAcquisition | null>(null);

  async function start() {
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/jumio/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driverId, consent: true }),
      });

      const payload = (await response.json()) as StartResponse;

      if (!response.ok || !payload.acquisition || !payload.verificationId) {
        setError(payload.error ?? "Could not start identity verification. Please try again.");
        setSubmitting(false);
        return;
      }

      if (payload.acquisition.channel === "redirect") {
        // Leaving the app entirely — no state to clean up, and `submitting`
        // stays true so the button cannot be pressed twice during navigation.
        window.location.assign(payload.acquisition.redirectUrl);
        return;
      }

      setVerificationId(payload.verificationId);
      setSdk(payload.acquisition);
    } catch {
      setError("Could not reach FreightID. Check your connection and try again.");
      setSubmitting(false);
    }
  }

  // The driver reached the end of the capture screens, one way or the other.
  // Not a result — the verification page reads the real state from the
  // database. `useCallback` because JumioWebSdk rebuilds itself on a new
  // identity, which would drop the camera.
  const finish = useCallback(() => {
    router.push(`/jumio-dashboard/verifications/${verificationId}`);
  }, [router, verificationId]);

  /**
   * Backing out before Jumio saw anything.
   *
   * The transaction already exists and its row is `INITIATED`, which counts as
   * active — leaving it there would block this driver from starting again
   * until the token expired. Telling the server to abandon it is what makes
   * "cancel" mean cancel.
   */
  async function cancel() {
    setSdk(null);

    try {
      await fetch("/api/jumio/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verificationId }),
      });
    } catch {
      // Navigating anyway — the driver page shows whatever actually happened.
    }

    router.push(`/jumio-dashboard/drivers/${driverId}`);
  }

  if (sdk) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background">
        <div className="flex items-center justify-between gap-4 border-b px-4 py-2">
          <p className="truncate text-sm font-medium">Verifying {driverName}</p>
          <Button variant="ghost" size="sm" onClick={cancel}>
            Cancel
          </Button>
        </div>

        <div className="min-h-0 flex-1">
          <JumioWebSdk
            token={sdk.token}
            datacenter={sdk.datacenter}
            locale={sdk.locale}
            onDone={finish}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3 text-sm">
        <p>
          FreightID needs to verify {driverName}&apos;s identity before they can be approved.
        </p>
        <p>
          The verification process may collect information from a government-issued ID and
          biometric information such as a selfie.
        </p>
        <p className="text-muted-foreground">
          {/* Placeholder, deliberately not a link: the privacy notice and the exact
              consent wording are the business and legal owners' to supply. */}
          Privacy notice to be supplied by FreightID legal before any real driver uses this flow.
        </p>
      </div>

      <div className="flex items-start gap-3">
        <input
          id="consent"
          type="checkbox"
          checked={consented}
          onChange={(event) => setConsented(event.target.checked)}
          disabled={submitting}
          className="mt-0.5 size-4 rounded border-border accent-primary"
        />
        <Label htmlFor="consent" className="text-sm font-normal">
          I consent to identity verification
        </Label>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button onClick={start} disabled={!consented || submitting}>
        {submitting ? "Starting…" : "Continue"}
      </Button>
    </div>
  );
}
