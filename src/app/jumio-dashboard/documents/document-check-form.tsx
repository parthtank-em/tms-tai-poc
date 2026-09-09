"use client";

import { useEffect, useRef, useState } from "react";

import { VerificationDecisionBadge, VerificationStatusBadge } from "@/components/jumio/verification-badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { JumioDecision, JumioVerificationStatus } from "@/generated/prisma/enums";

/**
 * Upload a document, then watch the answer come back.
 *
 * One screen, three states: a form, a wait, a result. The wait is not optional
 * — Jumio verifies asynchronously, so nothing useful exists at the moment the
 * upload returns, and a form that pretended otherwise would just show an empty
 * result and call it done.
 *
 * The result is rendered twice on purpose: the mapped fields as a table for
 * reading, and the raw extraction object underneath. Supporting documents do
 * not have one fixed shape, so anyone evaluating this integration needs to see
 * what Jumio actually sent, not only the parts we knew to name.
 */

/** Matches the server-side `ACCEPTED_MIME_TYPES`. A hint to the file dialog only. */
const ACCEPT = "image/jpeg,image/png,application/pdf";

const POLL_INTERVAL_MS = 3_000;
/** ~3 minutes. Past that the wait is Jumio's, not this page's. */
const MAX_POLLS = 60;

type DocumentType = { code: string; label: string };

type CheckView = {
  id: string;
  status: JumioVerificationStatus;
  decision: JumioDecision | null;
  riskScore: number | null;
  submitted: { type: string; country: string; fileName: string; sizeBytes: number };
  document: {
    type: string | null;
    subType: string | null;
    issuer: string | null;
    name: string | null;
    documentNumber: string | null;
    issuingDate: string | null;
    expiryDate: string | null;
  };
  address: { oneLine: string | null };
  extractedData: unknown;
  capabilities: unknown;
  error: string | null;
  completedAt: string | null;
};

const SETTLED: JumioVerificationStatus[] = [
  "PROCESSED",
  "SESSION_EXPIRED",
  "TOKEN_EXPIRED",
  "FAILED",
];

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid grid-cols-[minmax(9rem,auto)_1fr] gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value?.trim() ? value : "—"}</dd>
    </div>
  );
}

export function DocumentCheckForm({ documentTypes }: { documentTypes: readonly DocumentType[] }) {
  const formRef = useRef<HTMLFormElement>(null);

  const [documentType, setDocumentType] = useState<string | null>(documentTypes[0]?.code ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkId, setCheckId] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckView | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  const settled = check ? SETTLED.includes(check.status) : false;
  const waiting = checkId !== null && !settled && !gaveUp;

  // Poll until the check settles. The endpoint retrieves from Jumio itself when
  // the callback has not arrived, so this works with or without a tunnel.
  useEffect(() => {
    if (!checkId || settled) return;

    let polls = 0;
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch(`/api/jumio/documents/${checkId}`, { cache: "no-store" });
        if (!response.ok) return;

        const payload = (await response.json()) as CheckView;
        if (!cancelled) setCheck(payload);
      } catch {
        // A failed poll is not worth surfacing — the next tick tries again.
      }
    }

    void poll();

    const timer = setInterval(() => {
      polls += 1;

      if (polls > MAX_POLLS) {
        clearInterval(timer);
        if (!cancelled) setGaveUp(true);
        return;
      }

      void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [checkId, settled]);

  async function submit(formData: FormData) {
    setSubmitting(true);
    setError(null);
    setCheck(null);
    setCheckId(null);
    setGaveUp(false);

    try {
      const response = await fetch("/api/jumio/documents", { method: "POST", body: formData });
      const payload = (await response.json()) as { checkId?: string; error?: string };

      if (!response.ok || !payload.checkId) {
        setError(payload.error ?? "Could not submit the document. Please try again.");
        return;
      }

      setCheckId(payload.checkId);
    } catch {
      setError("Could not reach FreightID. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Upload a document</CardTitle>
          <CardDescription>
            JPEG, PNG or PDF, up to 15MB. The file is sent straight to Jumio and is not stored by
            FreightID.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form
            ref={formRef}
            action={submit}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label htmlFor="file">Document</Label>
              <Input id="file" name="file" type="file" accept={ACCEPT} required />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                {/* Jumio matches the upload against a template chosen by type and
                    country, so both are part of the request, not metadata. */}
                <input type="hidden" name="documentType" value={documentType ?? ""} />
                <Label htmlFor="documentType-trigger">Document type</Label>
                <Select
                  value={documentType}
                  onValueChange={(value) => setDocumentType(value as string | null)}
                >
                  <SelectTrigger id="documentType-trigger" className="w-full">
                    <SelectValue placeholder="Choose a type" />
                  </SelectTrigger>
                  <SelectContent>
                    {documentTypes.map((type) => (
                      <SelectItem key={type.code} value={type.code}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="country">Issuing country</Label>
                <Input
                  id="country"
                  name="country"
                  defaultValue="USA"
                  required
                  maxLength={3}
                  autoComplete="off"
                  className="uppercase"
                />
                <p className="text-xs text-muted-foreground">ISO 3166-1 alpha-3, e.g. USA.</p>
              </div>
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={submitting || waiting || !documentType}>
                {submitting ? "Uploading…" : "Submit"}
              </Button>

              {(check || checkId) && !submitting && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    formRef.current?.reset();
                    setCheck(null);
                    setCheckId(null);
                    setGaveUp(false);
                    setError(null);
                  }}
                >
                  Start over
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {checkId && (
        <Card>
          <CardHeader>
            <CardTitle>Response</CardTitle>
            <CardDescription>
              {waiting && "Jumio is verifying the document. This updates on its own."}
              {!waiting && gaveUp && "Still processing at Jumio. Reload to check again."}
              {settled && check?.status === "PROCESSED" && "Jumio finished processing this document."}
              {settled &&
                check?.status !== "PROCESSED" &&
                "This check did not complete — see the status below."}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6">
            {!check ? (
              <p className="text-sm text-muted-foreground">Waiting for the first result…</p>
            ) : (
              <>
                <dl className="divide-y">
                  <div className="grid grid-cols-[minmax(9rem,auto)_1fr] gap-4 py-1.5 text-sm">
                    <dt className="text-muted-foreground">Status</dt>
                    <dd>
                      <VerificationStatusBadge status={check.status} />
                    </dd>
                  </div>
                  <div className="grid grid-cols-[minmax(9rem,auto)_1fr] gap-4 py-1.5 text-sm">
                    <dt className="text-muted-foreground">Decision</dt>
                    <dd>
                      <VerificationDecisionBadge decision={check.decision} />
                    </dd>
                  </div>
                  <Field
                    label="Risk score"
                    value={check.riskScore === null ? null : String(check.riskScore)}
                  />
                  <Field label="Document type" value={check.document.type} />
                  <Field label="Sub type" value={check.document.subType} />
                  <Field label="Issuer" value={check.document.issuer} />
                  <Field label="Name" value={check.document.name} />
                  <Field label="Address" value={check.address.oneLine} />
                  <Field label="Document number" value={check.document.documentNumber} />
                  <Field label="Issued" value={check.document.issuingDate} />
                  <Field label="Expires" value={check.document.expiryDate} />
                  <Field label="File" value={check.submitted.fileName} />
                </dl>

                {check.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {check.error}
                  </p>
                )}

                <div className="space-y-2">
                  <p className="text-sm font-medium">Raw response</p>
                  <pre className="max-h-96 overflow-auto rounded-md bg-muted p-4 text-xs leading-relaxed">
                    {JSON.stringify(check, null, 2)}
                  </pre>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
