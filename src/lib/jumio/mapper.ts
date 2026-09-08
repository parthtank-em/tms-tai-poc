import type { JumioDecision, JumioVerificationStatus } from "@/generated/prisma/enums";

import type { JumioExtractionData, JumioWorkflowDetails } from "./types";

/**
 * Jumio response → FreightID representation (§16).
 *
 * This is the seam. Everything above it — routes, UI, the database — speaks
 * FreightID's vocabulary, so replacing Jumio later means rewriting this file
 * and nothing else.
 *
 * Every function is pure and total: unknown values map to a safe default rather
 * than throwing, because a vendor adding an enum value must not take down a
 * callback handler.
 */

export type FreightIdVerificationResult = {
  status: JumioVerificationStatus;
  decision: JumioDecision | null;
  /** 0–100. Null when absent, or when Jumio reports `-1` for "never executed". */
  riskScore: number | null;
  documentType: string | null;
  documentSubType: string | null;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: Date | null;
  licenseNumber: string | null;
  licenseExpiry: Date | null;
  issuingCountry: string | null;
  issuingState: string | null;
  /** Capability labels, e.g. `PASSED` / `OK`. Not the raw capability object. */
  liveness: string | null;
  faceMatch: string | null;
  /** Per-capability labels for the detail view: `{ extraction: "OK", ... }`. */
  decisionDetails: Record<string, string>;
  completedAt: Date | null;
};

const WORKFLOW_STATUSES: Record<string, JumioVerificationStatus> = {
  INITIATED: "INITIATED",
  ACQUISITION_STARTED: "ACQUISITION_STARTED",
  ACQUIRED: "ACQUIRED",
  PROCESSING: "PROCESSING",
  PROCESSED: "PROCESSED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
};

const DECISIONS: Record<string, JumioDecision> = {
  PASSED: "PASSED",
  WARNING: "WARNING",
  REJECTED: "REJECTED",
  NOT_EXECUTED: "NOT_EXECUTED",
};

/**
 * A status value we do not recognise maps to `PROCESSING`, not `FAILED`.
 *
 * An unknown state is an unfinished one as far as FreightID is concerned —
 * guessing `FAILED` would show a driver a rejection that Jumio never issued.
 */
export function mapWorkflowStatus(raw: string | null | undefined): JumioVerificationStatus {
  if (!raw) return "PROCESSING";
  return WORKFLOW_STATUSES[raw.toUpperCase()] ?? "PROCESSING";
}

export function mapDecision(raw: string | null | undefined): JumioDecision | null {
  if (!raw) return null;
  return DECISIONS[raw.toUpperCase()] ?? null;
}

/** `-1` is Jumio's "workflow not executed" sentinel, not a real score. */
export function mapRiskScore(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || Number.isNaN(raw) || raw < 0) return null;
  return raw;
}

/**
 * `YYYY-MM-DD` → midnight UTC.
 *
 * Parsed explicitly rather than via `new Date(string)`: these are calendar
 * dates on a document, and letting them drift into a local timezone can move a
 * date of birth or a licence expiry by a day.
 */
export function parseJumioDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);

  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTimestamp(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/**
 * The first capability entry is the one that ran.
 *
 * Jumio returns each capability as an array — one entry per credential it was
 * applied to. A POC workflow has a single ID and a single selfie, so entry zero
 * is the result; a multi-document workflow would need to select by credential.
 */
function firstCapability<T>(list: { decision?: { details?: { label?: string } }; data?: T }[] | undefined) {
  return list?.[0];
}

export function mapWorkflowDetails(details: JumioWorkflowDetails): FreightIdVerificationResult {
  const capabilities = details.capabilities ?? {};

  const extraction = firstCapability<JumioExtractionData>(capabilities.extraction);
  const similarity = firstCapability<{ similarity?: string }>(capabilities.similarity);
  const liveness = firstCapability<{ type?: string }>(capabilities.liveness);

  const document = extraction?.data ?? {};

  // Face match has two useful readings: the capability's own label and the
  // MATCH/MISMATCH datum. The datum is more specific, so it wins.
  const faceMatch =
    trimmed(similarity?.data?.similarity) ?? trimmed(similarity?.decision?.details?.label);

  const decisionDetails: Record<string, string> = {};
  for (const [name, list] of Object.entries(capabilities)) {
    const label = firstCapability(list as { decision?: { details?: { label?: string } } }[])?.decision
      ?.details?.label;
    if (label) decisionDetails[name] = label;
  }

  const workflowLabel = trimmed(details.decision?.details?.label);
  if (workflowLabel) decisionDetails.workflow = workflowLabel;

  return {
    status: mapWorkflowStatus(details.workflow?.status),
    decision: mapDecision(details.decision?.type),
    riskScore: mapRiskScore(details.decision?.risk?.score),
    documentType: trimmed(document.type),
    documentSubType: trimmed(document.subType),
    firstName: trimmed(document.firstName),
    lastName: trimmed(document.lastName),
    dateOfBirth: parseJumioDate(document.dateOfBirth),
    licenseNumber: trimmed(document.documentNumber),
    licenseExpiry: parseJumioDate(document.expiryDate),
    issuingCountry: trimmed(document.issuingCountry),
    issuingState: trimmed(document.state),
    liveness: trimmed(liveness?.decision?.details?.label),
    faceMatch,
    decisionDetails,
    completedAt: parseTimestamp(details.completedAt),
  };
}

/**
 * The app-wide driver rollup (`Driver.verificationStatus`), derived from the
 * Jumio decision.
 *
 * `WARNING` deliberately does not become `VERIFIED`. Jumio's own default bands
 * put it between passed and rejected, and FreightID treats "not clearly passed"
 * as "not verified" until the business defines its own policy (§17).
 */
export function rollupDriverStatus(
  result: FreightIdVerificationResult,
): "UNVERIFIED" | "PENDING" | "VERIFIED" | "FAILED" {
  if (result.status === "PROCESSED") {
    if (result.decision === "PASSED") return "VERIFIED";
    if (result.decision === "REJECTED" || result.decision === "WARNING") return "FAILED";
    return "UNVERIFIED";
  }

  if (
    result.status === "SESSION_EXPIRED" ||
    result.status === "TOKEN_EXPIRED" ||
    result.status === "FAILED"
  ) {
    return "FAILED";
  }

  return "PENDING";
}
