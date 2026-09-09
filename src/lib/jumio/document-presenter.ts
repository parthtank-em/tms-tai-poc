import type { DocumentCheckModel } from "@/generated/prisma/models";

/**
 * The outward-facing shape of a document check.
 *
 * Same job as `presenter.ts` does for identity verifications: one place that
 * decides what leaves the server, so the polling endpoint and the page cannot
 * drift apart and neither can reach a raw Jumio payload.
 *
 * Unlike that file there is no reduced "status only" variant. This screen
 * exists to show the extracted data — withholding it from the endpoint that
 * feeds the screen would mean the screen could not do its one job.
 */

type DocumentCheckRow = Pick<
  DocumentCheckModel,
  | "id"
  | "status"
  | "decision"
  | "riskScore"
  | "requestedType"
  | "requestedCountry"
  | "fileName"
  | "fileMimeType"
  | "fileSizeBytes"
  | "documentType"
  | "documentSubType"
  | "issuer"
  | "extractedName"
  | "addressLine1"
  | "addressLine2"
  | "addressCity"
  | "addressSubdivision"
  | "addressPostalCode"
  | "addressCountry"
  | "formattedAddress"
  | "documentNumber"
  | "issuingDate"
  | "expiryDate"
  | "extractedData"
  | "decisionDetails"
  | "error"
  | "startedAt"
  | "completedAt"
>;

/** `Date` → `YYYY-MM-DD`, in UTC, matching how the rest of the app formats dates. */
function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/**
 * A single-line address.
 *
 * Jumio's own `formattedAddress` wins when it is there. The fallback joins
 * whichever parts came back, because a document that yielded only a city and a
 * postcode should still show something rather than an em dash.
 */
export function oneLineAddress(check: DocumentCheckRow): string | null {
  if (check.formattedAddress) return check.formattedAddress;

  const parts = [
    check.addressLine1,
    check.addressLine2,
    check.addressCity,
    check.addressSubdivision,
    check.addressPostalCode,
    check.addressCountry,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(", ") : null;
}

export type DocumentCheckView = ReturnType<typeof toDocumentCheckView>;

export function toDocumentCheckView(check: DocumentCheckRow) {
  return {
    id: check.id,
    status: check.status,
    decision: check.decision,
    riskScore: check.riskScore,
    submitted: {
      type: check.requestedType,
      country: check.requestedCountry,
      fileName: check.fileName,
      mimeType: check.fileMimeType,
      sizeBytes: check.fileSizeBytes,
    },
    document: {
      type: check.documentType,
      subType: check.documentSubType,
      issuer: check.issuer,
      name: check.extractedName,
      documentNumber: check.documentNumber,
      issuingDate: isoDate(check.issuingDate),
      expiryDate: isoDate(check.expiryDate),
    },
    address: {
      line1: check.addressLine1,
      line2: check.addressLine2,
      city: check.addressCity,
      subdivision: check.addressSubdivision,
      postalCode: check.addressPostalCode,
      country: check.addressCountry,
      oneLine: oneLineAddress(check),
    },
    /**
     * Jumio's extraction object as it came back.
     *
     * Deliberately exposed: supporting documents do not have one fixed shape,
     * and an operator evaluating this integration needs to see what Jumio
     * actually returned, not only the fields we thought to map.
     */
    extractedData: check.extractedData ?? null,
    capabilities: check.decisionDetails ?? null,
    error: check.error,
    startedAt: check.startedAt.toISOString(),
    completedAt: check.completedAt?.toISOString() ?? null,
  };
}

/** Which of the three UI states to render: still running, finished, finished badly. */
export function documentCheckPhase(
  status: DocumentCheckRow["status"],
  decision: DocumentCheckRow["decision"],
): "pending" | "passed" | "failed" {
  if (status === "PROCESSED") {
    return decision === "PASSED" ? "passed" : "failed";
  }

  if (status === "SESSION_EXPIRED" || status === "TOKEN_EXPIRED" || status === "FAILED") {
    return "failed";
  }

  return "pending";
}
