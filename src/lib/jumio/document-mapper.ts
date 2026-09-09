import { mapDecision, mapRiskScore, mapWorkflowStatus, parseJumioDate } from "./mapper";

import type { JumioDecision, JumioVerificationStatus } from "@/generated/prisma/enums";

import type { JumioDocumentExtractionData, JumioWorkflowDetails } from "./types";

/**
 * Jumio document-workflow response → FreightID representation.
 *
 * The sibling of `mapWorkflowDetails` in `mapper.ts`, and it reuses that file's
 * status/decision/date primitives rather than restating them: the workflow
 * envelope is identical for both flows, only the extracted payload differs.
 *
 * What differs is worth being explicit about. An identity workflow extracts a
 * known set of fields from a known document. A supporting document does not
 * have a fixed shape — a utility bill, a bank statement and a lease agreement
 * agree on very little — so this maps the fields we can name and hands the
 * whole extraction object back untouched alongside them.
 */

export type DocumentCheckResult = {
  status: JumioVerificationStatus;
  decision: JumioDecision | null;
  riskScore: number | null;
  documentType: string | null;
  documentSubType: string | null;
  issuer: string | null;
  name: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressSubdivision: string | null;
  addressPostalCode: string | null;
  addressCountry: string | null;
  formattedAddress: string | null;
  documentNumber: string | null;
  issuingDate: Date | null;
  expiryDate: Date | null;
  /** `capabilities.extraction[0].data` verbatim, or null when nothing extracted. */
  extractedData: Record<string, unknown> | null;
  decisionDetails: Record<string, string>;
  completedAt: Date | null;
};

function trimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function parseTimestamp(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The document credential's extraction entry.
 *
 * A document workflow has one credential, so entry zero is the answer — but it
 * is selected by category where Jumio labels it, so that a workflow later
 * extended with a second credential reads the right one instead of whichever
 * happened to be first.
 */
function documentExtraction(details: JumioWorkflowDetails) {
  const entries = details.capabilities?.extraction ?? [];

  return (
    entries.find((entry) =>
      entry.credentials?.some((credential) => credential.category === "DOCUMENT"),
    ) ?? entries[0]
  );
}

/**
 * A single readable name.
 *
 * Documents split this inconsistently — some give first/last, some give one
 * `name` string, some give neither — so the parts are joined when present and
 * the whole-name field is the fallback, rather than showing an operator a
 * half-empty pair of fields.
 */
function readName(data: JumioDocumentExtractionData): string | null {
  const parts = [trimmed(data.firstName), trimmed(data.lastName)].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : trimmed(data.name);
}

export function mapDocumentWorkflowDetails(details: JumioWorkflowDetails): DocumentCheckResult {
  const extraction = documentExtraction(details);
  const data = (extraction?.data ?? {}) as JumioDocumentExtractionData;
  const address = data.address ?? {};

  const decisionDetails: Record<string, string> = {};
  for (const [name, list] of Object.entries(details.capabilities ?? {})) {
    const label = (list as { decision?: { details?: { label?: string } } }[])[0]?.decision?.details
      ?.label;
    if (label) decisionDetails[name] = label;
  }

  const workflowLabel = trimmed(details.decision?.details?.label);
  if (workflowLabel) decisionDetails.workflow = workflowLabel;

  return {
    status: mapWorkflowStatus(details.workflow?.status),
    decision: mapDecision(details.decision?.type),
    riskScore: mapRiskScore(details.decision?.risk?.score),
    documentType: trimmed(data.type),
    documentSubType: trimmed(data.subType),
    issuer: trimmed(data.issuer),
    name: readName(data),
    addressLine1: trimmed(address.line1),
    addressLine2: trimmed(address.line2),
    addressCity: trimmed(address.city),
    addressSubdivision: trimmed(address.subdivision),
    addressPostalCode: trimmed(address.postalCode),
    addressCountry: trimmed(address.country) ?? trimmed(data.issuingCountry),
    formattedAddress: trimmed(address.formattedAddress),
    documentNumber: trimmed(data.documentNumber),
    issuingDate: parseJumioDate(data.issuingDate),
    expiryDate: parseJumioDate(data.expiryDate),
    extractedData: extraction?.data ? (extraction.data as Record<string, unknown>) : null,
    decisionDetails,
    completedAt: parseTimestamp(details.completedAt),
  };
}
