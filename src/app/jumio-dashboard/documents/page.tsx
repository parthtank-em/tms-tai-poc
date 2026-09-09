import Link from "next/link";

import { DocumentCheckForm } from "./document-check-form";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isJumioDocumentCheckConfigured } from "@/lib/jumio/config";
import { DOCUMENT_TYPES } from "@/lib/jumio/document-check";

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
  const configured = isJumioDocumentCheckConfigured();

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
            <CardTitle>Document checks are not configured</CardTitle>
            <CardDescription>
              This screen needs its own Jumio workflow — the one used for driver identity checks
              runs different capabilities against a different credential. Set
              <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">
                JUMIO_DOCUMENT_WORKFLOW_KEY
              </code>
              to a Doc Proof workflow your tenant has enabled, alongside the other
              <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">JUMIO_*</code>
              settings. See <code className="rounded bg-muted px-1 py-0.5 text-xs">.env.example</code>.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <DocumentCheckForm documentTypes={DOCUMENT_TYPES} />
      )}
    </main>
  );
}
