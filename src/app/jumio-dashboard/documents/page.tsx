import Link from "next/link";

import { DocumentCheckForm } from "./document-check-form";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isJumioConfigured } from "@/lib/jumio/config";
import { DEFAULT_DOCUMENT_TYPE, DOCUMENT_TYPES } from "@/lib/jumio/document-check";

export const metadata = {
  title: "Document check · FreightID",
  description: "Upload a document and see what Jumio verifies and extracts.",
};

/**
 * Standalone document verification.
 *
 * Deliberately unattached to a driver, a shipment or a consent flow: the
 * question this screen answers is "what does Jumio make of this file", and
 * anything else on the page would be in the way of reading the answer.
 */
export default function DocumentCheckPage() {
  const configured = isJumioConfigured();

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="mb-6">
        <Link
          href="/jumio-dashboard"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Jumio Dashboard
        </Link>
      </div>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Document check</h1>
        <p className="text-sm text-muted-foreground">
          Upload an address proof or other supporting document. Jumio verifies it and returns the
          data it can read off it.
        </p>
      </header>

      {!configured ? (
        <Card className="border-l-2 border-l-destructive">
          <CardHeader>
            <CardTitle>Jumio is not configured</CardTitle>
            <CardDescription>
              This screen needs the tenant credentials —
              <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">JUMIO_CLIENT_ID</code>,
              <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">JUMIO_CLIENT_SECRET</code>
              and the rest of the
              <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">JUMIO_*</code>
              settings. See <code className="rounded bg-muted px-1 py-0.5 text-xs">.env.example</code>.
              The workflow to run is not one of them — you type it into the form.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <DocumentCheckForm
          documentTypes={DOCUMENT_TYPES}
          defaultDocumentType={DEFAULT_DOCUMENT_TYPE}
        />
      )}
    </main>
  );
}
