"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { JumioWebSdk } from "@/components/jumio/web-sdk";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import {
  defaultAcquisitionChannel,
  type JumioAcquisition,
  type JumioAcquisitionChannel,
} from "@/lib/jumio/acquisition";

/**
 * Consent, then hand off to Jumio (§9, §10).
 *
 * The button is disabled until the box is ticked, and the API refuses the call
 * without `consent: true` as well — the server does not trust this component
 * to be the only way in.
 *
 * What happens next is the driver's choice, sent as `channel` and echoed back
 * in `acquisition`: the SDK opens the capture screens over this page, or the
 * browser navigates to Jumio's hosted Web Client. One account call produces
 * both handles, so the pick costs nothing extra and changes nothing about what
 * Jumio is told. Neither ending is a result — the driver lands on the
 * verification page, which reads the database.
 *
 * The choice is made before the transaction exists. Changing it afterwards
 * means cancelling and starting again, because one open verification per
 * driver is the rule the server enforces.
 */

type StartResponse = {
  verificationId?: string;
  acquisition?: JumioAcquisition;
  error?: string;
};

type SdkAcquisition = Extract<JumioAcquisition, { channel: "sdk" }>;

/** The two ways to reach Jumio, described the way a driver would judge them. */
const CHANNELS: ReadonlyArray<{
  value: JumioAcquisitionChannel;
  label: string;
  hint: string;
}> = [
  {
    value: "sdk",
    label: "Stay on FreightID (Using Jumio SDK)",
    hint: "The camera opens here. You never leave this page.",
  },
  {
    value: "redirect",
    label: "Redirect on the Jumio site (Using Jumio Web Client)",
    hint: "Opens Jumio's own page, then brings you back when you are done.",
  },
];

export function ConsentForm({ driverId, driverName }: { driverId: string; driverName: string }) {
  const router = useRouter();
  const [consented, setConsented] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [sdk, setSdk] = useState<SdkAcquisition | null>(null);
  // Seeded from the environment's default so the deployment's preferred route
  // is the one already selected; the driver is free to override it.
  const [channel, setChannel] = useState<JumioAcquisitionChannel>(defaultAcquisitionChannel);

  async function start() {
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/jumio/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driverId, consent: true, channel }),
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
    <FieldGroup>
      <Field>
        <FieldDescription>
          FreightID needs to verify {driverName}&apos;s identity before they can be approved.
        </FieldDescription>
        <FieldDescription>
          The verification process may collect information from a government-issued ID and
          biometric information such as a selfie.
        </FieldDescription>
        <FieldDescription>
          {/* Placeholder, deliberately not a link: the privacy notice and the exact
              consent wording are the business and legal owners' to supply. */}
          Privacy notice to be supplied by FreightID legal before any real driver uses this flow.
        </FieldDescription>
      </Field>

      <FieldSet>
        <FieldLegend variant="label">How would you like to verify?</FieldLegend>

        {/* `disabled` belongs on the group, not the fieldset: these are Base UI
            spans over a hidden input, so only the group knows how to stop them
            responding to a click. */}
        <RadioGroup
          value={channel}
          onValueChange={(value: JumioAcquisitionChannel) => setChannel(value)}
          disabled={submitting}
        >
          {CHANNELS.map((option) => (
            // The label wraps the radio rather than pointing at it with
            // `htmlFor`: Base UI renders a span whose only real input is
            // aria-hidden, and wrapping is what it reads to name the control.
            // It also makes the whole card the hit target.
            <FieldLabel key={option.value}>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>{option.label}</FieldTitle>
                  <FieldDescription>{option.hint}</FieldDescription>
                </FieldContent>
                <RadioGroupItem value={option.value} />
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
      </FieldSet>

      <FieldLabel className="font-normal">
        <Checkbox
          checked={consented}
          onCheckedChange={setConsented}
          disabled={submitting}
        />
        I consent to identity verification
      </FieldLabel>

      <FieldError>{error}</FieldError>

      <Button onClick={start} disabled={!consented || submitting} className="w-fit">
        {submitting ? "Starting…" : "Continue"}
      </Button>
    </FieldGroup>
  );
}
