import { JumioApiError, JumioClient } from "./client";
import { getJumioConfig, JumioConfigError, type JumioConfig } from "./config";
import { mapWorkflowDetails, mapWorkflowStatus, rollupDriverStatus } from "./mapper";
import { retrieveWorkflowWithBackoff } from "./retrieval";

import type { Prisma } from "@/generated/prisma/client";
import type { JumioVerificationStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

import type { JumioCallbackPayload, JumioCreateAccountRequest } from "./types";

/**
 * The Jumio verification service — the only module that writes verification
 * state. Routes stay thin and the ordering rules below stay in one place.
 *
 * Two of those rules are worth stating up front:
 *
 * - **A browser redirect is never evidence.** Returning to the success URL only
 *   means the driver finished the capture UI. Status changes come from the
 *   callback plus retrieval, never from the redirect (§10).
 * - **State never goes backwards.** Callbacks can arrive out of order, so an
 *   `ACQUIRED` notification landing after `PROCESSED` must not un-verify a
 *   driver.
 */

/** Terminal states. Once here, an out-of-order callback can no longer move us. */
const TERMINAL: readonly JumioVerificationStatus[] = [
  "PROCESSED",
  "SESSION_EXPIRED",
  "TOKEN_EXPIRED",
  "FAILED",
];

/** How far along the acquisition each state is, for the no-going-backwards rule. */
const PROGRESS: Record<JumioVerificationStatus, number> = {
  INITIATED: 0,
  ACQUISITION_STARTED: 1,
  ACQUIRED: 2,
  PROCESSING: 3,
  PROCESSED: 4,
  SESSION_EXPIRED: 4,
  TOKEN_EXPIRED: 4,
  FAILED: 4,
};

export type ConsentInput = {
  obtainedAt: Date;
  /** Jumio requires this. Null only when the platform gave us no client address. */
  ip: string | null;
  /** ISO 3166-1 alpha-3. Required by Jumio on every account call. */
  country: string;
  /** Required by Jumio when `country` is USA, meaningless elsewhere. */
  state: string | null;
};

export type StartVerificationResult =
  | { ok: true; verificationId: string; redirectUrl: string }
  | { ok: false; reason: string; retryable: boolean };

/**
 * An attempt is "active" while it could still produce a result. Starting a
 * second one alongside it would leave two open Jumio transactions for one
 * driver and make the callback ordering ambiguous.
 */
export async function findActiveVerification(driverId: string) {
  return prisma.driverVerification.findFirst({
    where: { driverId, status: { notIn: [...TERMINAL] } },
    orderBy: { createdAt: "desc" },
  });
}

export async function latestVerification(driverId: string) {
  return prisma.driverVerification.findFirst({
    where: { driverId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Start a verification: create the local record, then the Jumio transaction.
 *
 * The local row comes first so its id can serve as `customerInternalReference`
 * — an opaque UUID, which is exactly what Jumio asks for and what keeps driver
 * PII out of their reference fields (§8).
 */
export async function startDriverVerification(
  driverId: string,
  consent: ConsentInput,
  client?: JumioClient,
): Promise<StartVerificationResult> {
  let config: JumioConfig;

  try {
    config = getJumioConfig();
  } catch (error) {
    if (error instanceof JumioConfigError) {
      // The operator needs the specific variable name; the driver must not see it.
      console.error(`[jumio] Not configured: ${error.message}`);
      return {
        ok: false,
        reason: "Identity verification is not available right now.",
        retryable: false,
      };
    }
    throw error;
  }

  const driver = await prisma.driver.findUnique({ where: { id: driverId }, select: { id: true } });

  if (!driver) {
    return { ok: false, reason: "Driver not found.", retryable: false };
  }

  const active = await findActiveVerification(driverId);
  if (active) {
    return {
      ok: false,
      reason: "A verification is already in progress for this driver.",
      retryable: false,
    };
  }

  const verification = await prisma.driverVerification.create({
    data: {
      driverId,
      status: "INITIATED",
      jumioWorkflowKey: config.workflowKey,
      consentObtainedAt: consent.obtainedAt,
      consentIp: consent.ip,
      consentCountry: consent.country,
      consentState: consent.state,
    },
    select: { id: true },
  });

  const body: JumioCreateAccountRequest = {
    // Opaque identifiers only — no name, email, phone or licence number (§8).
    customerInternalReference: verification.id,
    userReference: driverId,
    workflowDefinition: { key: config.workflowKey },
    callbackUrl: config.callbackUrl,
    web: {
      // No query string on either URL: Jumio rejects success/error URLs that
      // carry query parameters, ports, IP addresses or fragments. The Web
      // Client appends its own (`acquisitionStatus`, `errorCode`, ...), which
      // is what the return page reads.
      successUrl: `${config.appUrl}/jumio-dashboard/verifications/${verification.id}`,
      errorUrl: `${config.appUrl}/jumio-dashboard/verifications/${verification.id}`,
      locale: "en",
    },
    userConsent: {
      userIp: consent.ip ?? undefined,
      // Always sent. Jumio rejects the whole call with a 400 when userLocation
      // is missing, and the state half is mandatory for the USA.
      userLocation: {
        country: consent.country,
        ...(consent.state ? { state: consent.state } : {}),
      },
      consent: { obtained: "yes", obtainedAt: consent.obtainedAt.toISOString() },
    },
    ...(config.tokenLifetime ? { tokenLifetime: config.tokenLifetime } : {}),
  };

  try {
    const response = await (client ?? new JumioClient(config)).createAccount(body);

    const accountId = response.account?.id ?? null;
    const workflowId = response.workflowExecution?.id ?? null;
    const redirectUrl = response.web?.href ?? null;

    if (!accountId || !workflowId || !redirectUrl) {
      throw new JumioApiError(
        "Jumio response was missing the account, workflow or Web Client URL.",
        null,
        false,
      );
    }

    await prisma.driverVerification.update({
      where: { id: verification.id },
      data: { jumioAccountId: accountId, jumioWorkflowId: workflowId },
    });

    await prisma.driver.update({
      where: { id: driverId },
      data: { verificationStatus: "PENDING" },
    });

    return { ok: true, verificationId: verification.id, redirectUrl };
  } catch (error) {
    const apiError = error instanceof JumioApiError ? error : null;
    const reason = apiError?.message ?? "Could not start identity verification.";

    // Mark the row failed rather than deleting it: a failed start is a real
    // event worth seeing, and the plan is explicit that we must not fabricate a
    // verification that never happened (§21).
    await prisma.driverVerification.update({
      where: { id: verification.id },
      data: { status: "FAILED", error: reason, completedAt: new Date() },
    });

    // The sanitized reason goes on the row and to the user; Jumio's own
    // explanation goes to the log, which is the only place it belongs.
    console.error(
      `[jumio] Account creation failed for verification ${verification.id}: ${reason}` +
        (apiError?.details ? ` Jumio said: ${apiError.details}` : ""),
    );

    return { ok: false, reason, retryable: apiError?.retryable ?? true };
  }
}

export type CallbackRecordResult = {
  /** False when the same delivery has already been stored (§12). */
  stored: boolean;
  verificationId: string | null;
  /** Set instead of `verificationId` when the workflow was a document check. */
  documentCheckId: string | null;
  workflowExecutionId: string | null;
};

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Persist a callback before understanding it, the same way the TAI webhooks do.
 *
 * A delivery that matches no known verification is still stored, flagged
 * `matched: false`. That is an audit signal — someone posting arbitrary
 * workflow ids at the endpoint — and it explicitly does not touch any driver.
 *
 * Two kinds of workflow arrive on this one endpoint: identity verifications and
 * document checks. Jumio has no idea they are different, and the callback body
 * does not say, so the workflow execution id is looked up against both tables.
 * They can never collide — an execution id belongs to exactly one transaction.
 */
export async function recordJumioCallback(
  payload: JumioCallbackPayload,
  meta: { remoteIp: string | null },
): Promise<CallbackRecordResult> {
  const workflowExecutionId = payload.workflowExecution?.id ?? null;
  const accountId = payload.account?.id ?? null;
  const status = payload.workflowExecution?.status ?? "UNKNOWN";

  const sentAt = payload.callbackSentAt ? new Date(payload.callbackSentAt) : null;
  const callbackSentAt = sentAt && !Number.isNaN(sentAt.getTime()) ? sentAt : null;

  if (!workflowExecutionId) {
    await prisma.jumioCallbackEvent.create({
      data: {
        workflowExecutionId: "",
        accountId,
        status,
        callbackSentAt,
        payload: payload as Prisma.InputJsonValue,
        matched: false,
        remoteIp: meta.remoteIp,
        error: "Callback carried no workflowExecution.id.",
      },
    });

    return { stored: true, verificationId: null, documentCheckId: null, workflowExecutionId: null };
  }

  const [verification, documentCheck] = await Promise.all([
    prisma.driverVerification.findFirst({
      where: { jumioWorkflowId: workflowExecutionId },
      select: { id: true },
    }),
    prisma.documentCheck.findFirst({
      where: { jumioWorkflowId: workflowExecutionId },
      select: { id: true },
    }),
  ]);

  const matched = Boolean(verification ?? documentCheck);

  if (!matched) {
    console.warn(
      `[jumio] Callback for unknown workflow ${workflowExecutionId} from ${meta.remoteIp ?? "unknown ip"}.`,
    );
  }

  const identifiers = {
    verificationId: verification?.id ?? null,
    documentCheckId: documentCheck?.id ?? null,
    workflowExecutionId,
  };

  try {
    await prisma.jumioCallbackEvent.create({
      data: {
        workflowExecutionId,
        accountId,
        status,
        callbackSentAt,
        payload: payload as Prisma.InputJsonValue,
        verificationId: identifiers.verificationId,
        documentCheckId: identifiers.documentCheckId,
        matched,
        remoteIp: meta.remoteIp,
      },
    });
  } catch (error) {
    // P2002 on the callback identity: Jumio redelivered something we already
    // have. That is a success, not a failure — ack it and do no further work.
    if (isUniqueViolation(error)) {
      return { stored: false, ...identifiers };
    }
    throw error;
  }

  return { stored: true, ...identifiers };
}

/**
 * Advance a verification from a callback status alone.
 *
 * Interim states (`ACQUISITION_STARTED`, `ACQUIRED`) carry no result, so they
 * only move the status forward. The decision comes from retrieval.
 */
export async function applyCallbackStatus(verificationId: string, rawStatus: string): Promise<void> {
  const incoming = mapWorkflowStatus(rawStatus);

  const current = await prisma.driverVerification.findUnique({
    where: { id: verificationId },
    select: { status: true, driverId: true },
  });

  if (!current || PROGRESS[incoming] <= PROGRESS[current.status]) return;

  await prisma.driverVerification.update({
    where: { id: verificationId },
    data: {
      status: incoming,
      ...(TERMINAL.includes(incoming) && incoming !== "PROCESSED"
        ? { completedAt: new Date() }
        : {}),
    },
  });

  if (incoming === "SESSION_EXPIRED" || incoming === "TOKEN_EXPIRED") {
    // An expired session is not a rejected driver. Roll the driver back to
    // unverified so they can simply start again (§21).
    await prisma.driver.update({
      where: { id: current.driverId },
      data: { verificationStatus: "UNVERIFIED" },
    });
  }
}

/**
 * Fetch the real result from Jumio and persist the mapped fields.
 *
 * This is the only path that can mark a driver `VERIFIED`.
 */
export async function syncVerificationFromJumio(
  verificationId: string,
  client?: JumioClient,
): Promise<void> {
  const verification = await prisma.driverVerification.findUnique({
    where: { id: verificationId },
    select: {
      id: true,
      driverId: true,
      jumioAccountId: true,
      jumioWorkflowId: true,
      retrievalAttempts: true,
      decision: true,
    },
  });

  if (!verification?.jumioAccountId || !verification.jumioWorkflowId) return;

  try {
    const { details, attempts } = await retrieveWorkflowWithBackoff(
      verification.jumioAccountId,
      verification.jumioWorkflowId,
      client ?? new JumioClient(),
    );

    const result = mapWorkflowDetails(details);
    const settled = result.status === "PROCESSED";

    await prisma.driverVerification.update({
      where: { id: verification.id },
      data: {
        status: result.status,
        decision: result.decision,
        riskScore: result.riskScore,
        documentType: result.documentType,
        documentSubType: result.documentSubType,
        extractedFirstName: result.firstName,
        extractedLastName: result.lastName,
        extractedDob: result.dateOfBirth,
        licenseNumber: result.licenseNumber,
        licenseExpiry: result.licenseExpiry,
        issuingCountry: result.issuingCountry,
        issuingState: result.issuingState,
        livenessDecision: result.liveness,
        faceMatchDecision: result.faceMatch,
        decisionDetails: result.decisionDetails as Prisma.InputJsonValue,
        retrievalAttempts: verification.retrievalAttempts + attempts,
        retrievedAt: new Date(),
        error: null,
        ...(settled ? { completedAt: result.completedAt ?? new Date() } : {}),
      },
    });

    const rollup = rollupDriverStatus(result);

    await prisma.driver.update({
      where: { id: verification.driverId },
      data: {
        verificationStatus: rollup,
        // Only a passed check sets the timestamp.
        ...(rollup === "VERIFIED" ? { verifiedAt: result.completedAt ?? new Date() } : {}),
      },
    });
  } catch (error) {
    const reason =
      error instanceof JumioApiError
        ? error.message
        : "Could not retrieve the verification result.";

    // Retrieval failing does not invalidate the driver — it means we do not know
    // yet, which is `PROCESSING`, not `PROCESSED` (§21).
    //
    // The callback that triggered this has usually already advanced the row to
    // PROCESSED. Left there with no decision, the UI reads it as a verification
    // that did not pass — telling an operator a driver was rejected when all
    // that actually happened is that we could not fetch the answer.
    await prisma.driverVerification.update({
      where: { id: verification.id },
      data: {
        retrievalAttempts: { increment: 1 },
        error: reason,
        ...(verification.decision ? {} : { status: "PROCESSING", completedAt: null }),
      },
    });

    console.error(`[jumio] Retrieval failed for verification ${verification.id}: ${reason}`);
  }
}
