"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

/**
 * Consent, then hand off to Jumio (§9, §10).
 *
 * The button is disabled until the box is ticked, and the API refuses the call
 * without `consent: true` as well — the server does not trust this component to
 * be the only way in.
 *
 * On success the browser navigates to Jumio's Web Client. Nothing about that
 * redirect implies a result: the driver comes back through a return page that
 * reads the verification state, and the state itself only ever moves on a
 * callback.
 */
export function ConsentForm({ driverId, driverName }: { driverId: string; driverName: string }) {
  const [consented, setConsented] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/jumio/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driverId, consent: true }),
      });

      const payload = (await response.json()) as { redirectUrl?: string; error?: string };

      if (!response.ok || !payload.redirectUrl) {
        setError(payload.error ?? "Could not start identity verification. Please try again.");
        setSubmitting(false);
        return;
      }

      // Leaving the app entirely — no state to clean up, and `submitting` stays
      // true so the button cannot be pressed twice during navigation.
      window.location.assign(payload.redirectUrl);
    } catch {
      setError("Could not reach FreightID. Check your connection and try again.");
      setSubmitting(false);
    }
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
