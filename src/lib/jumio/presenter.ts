import type { DriverVerificationModel } from "@/generated/prisma/models";

/**
 * The outward-facing shape of a verification (§16, §19).
 *
 * Both the JSON endpoint and the UI read from here, so they cannot drift, and
 * neither can reach the raw Jumio payloads.
 *
 * The two views differ on purpose. `toStatusResponse` is the API: it leaves out
 * date of birth and licence number, because a status poll does not need to
 * carry identity documents around. `toVerificationView` is the server-rendered
 * operator screen, where those fields are the point.
 */

type VerificationRow = Pick<
  DriverVerificationModel,
  | "id"
  | "status"
  | "decision"
  | "riskScore"
  | "documentType"
  | "documentSubType"
  | "extractedFirstName"
  | "extractedLastName"
  | "extractedDob"
  | "licenseNumber"
  | "licenseExpiry"
  | "issuingCountry"
  | "issuingState"
  | "livenessDecision"
  | "faceMatchDecision"
  | "error"
  | "startedAt"
  | "completedAt"
>;

/** `Date` → `YYYY-MM-DD`, in UTC, matching how the rest of the app formats dates. */
function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

export function toStatusResponse(verification: VerificationRow) {
  return {
    status: verification.status,
    decision: verification.decision,
    riskScore: verification.riskScore,
    document: {
      type: verification.documentType,
      subType: verification.documentSubType,
      firstName: verification.extractedFirstName,
      lastName: verification.extractedLastName,
      expiryDate: isoDate(verification.licenseExpiry),
      issuingCountry: verification.issuingCountry,
      issuingState: verification.issuingState,
    },
    liveness: verification.livenessDecision,
    faceMatch: verification.faceMatchDecision,
    startedAt: verification.startedAt.toISOString(),
    completedAt: verification.completedAt?.toISOString() ?? null,
  };
}

export type VerificationView = ReturnType<typeof toVerificationView>;

export function toVerificationView(verification: VerificationRow) {
  return {
    ...toStatusResponse(verification),
    id: verification.id,
    dateOfBirth: isoDate(verification.extractedDob),
    licenseNumber: verification.licenseNumber,
    error: verification.error,
  };
}

/**
 * Which of the three UI states to render (§18): still running, finished, or
 * finished badly.
 */
export function verificationPhase(
  status: VerificationRow["status"],
  decision: VerificationRow["decision"],
): "pending" | "passed" | "failed" {
  if (status === "PROCESSED") {
    return decision === "PASSED" ? "passed" : "failed";
  }

  if (status === "SESSION_EXPIRED" || status === "TOKEN_EXPIRED" || status === "FAILED") {
    return "failed";
  }

  return "pending";
}
