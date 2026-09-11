import { JumioApiError, JumioClient } from "./client";
import { getJumioConfig, JUMIO_LOCALE, JumioConfigError } from "./config";
import { mapWorkflowDetails } from "./mapper";
import { retrieveWorkflowWithBackoff } from "./retrieval";

import { prisma } from "@/lib/prisma";

import type { JumioAcquisition } from "./acquisition";

/**
 * Pickup re-authentication — "is the driver in front of me the one we verified?"
 *
 * A second, much smaller Jumio workflow run against the account created at
 * registration: one live selfie, compared to the facemap already on that
 * account. No document, no extraction.
 *
 * **Nothing here writes to the database.** This is a demonstration flow — it
 * reads the registration account id, runs the workflow, and hands the result
 * straight back to the screen. That is a deliberate limit, not an oversight:
 * there is no row, no callback, and therefore no audit trail, so a real
 * release-the-shipment decision must not be hung off it as it stands.
 */

export type PickupStartResult =
  | { ok: true; accountId: string; workflowExecutionId: string; acquisition: JumioAcquisition }
  | { ok: false; reason: string };

export type PickupResult = {
  /** `PASSED`, `WARNING`, `REJECTED`, `NOT_EXECUTED`, or null while unsettled. */
  decision: string | null;
  riskScore: number | null;
  liveness: string | null;
  faceMatch: string | null;
  /** Every capability's own label, for the detail list. */
  capabilities: Record<string, string>;
  completedAt: string | null;
  settled: boolean;
};

/**
 * The account the driver was enrolled on.
 *
 * Their most recent verification that actually passed — an account from a
 * rejected or abandoned attempt holds no facemap worth comparing against.
 */
async function enrolledAccountId(driverId: string): Promise<string | null> {
  const passed = await prisma.driverVerification.findFirst({
    where: { driverId, decision: "PASSED", jumioAccountId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { jumioAccountId: true },
  });

  return passed?.jumioAccountId ?? null;
}

export async function startPickupVerification(
  driverId: string,
  client?: JumioClient,
): Promise<PickupStartResult> {
  let config;

  try {
    config = getJumioConfig();
  } catch (error) {
    if (error instanceof JumioConfigError) {
      console.error(`[jumio] Pickup unavailable: ${error.message}`);
      return { ok: false, reason: "Identity verification is not available right now." };
    }
    throw error;
  }

  if (!config.authWorkflowKey) {
    console.error("[jumio] JUMIO_AUTH_WORKFLOW_KEY is not set. See .env.example.");
    return { ok: false, reason: "Pickup verification is not configured." };
  }

  const accountId = await enrolledAccountId(driverId);

  if (!accountId) {
    return { ok: false, reason: "This driver has no passed identity verification to re-check." };
  }

  try {
    const response = await (client ?? new JumioClient(config)).authenticateAccount(accountId, {
      // No database row to name, so the reference is the transaction's own
      // identity. Still opaque — no driver PII crosses (§8).
      customerInternalReference: `pickup-${crypto.randomUUID()}`,
      userReference: driverId,
      workflowDefinition: { key: config.authWorkflowKey },
    });

    const workflowExecutionId = response.workflowExecution?.id ?? null;
    const token = response.sdk?.token ?? null;

    if (!workflowExecutionId || !token) {
      throw new JumioApiError(
        "Pickup verification could not be started.",
        null,
        false,
        "Jumio returned no workflowExecution.id or sdk.token for the authentication workflow. " +
          `Check that workflow ${config.authWorkflowKey} exists and has the SDK acquisition channel enabled.`,
      );
    }

    return {
      ok: true,
      accountId,
      workflowExecutionId,
      acquisition: {
        channel: "sdk",
        token,
        datacenter: config.sdkDatacenter,
        locale: JUMIO_LOCALE,
      },
    };
  } catch (error) {
    const apiError = error instanceof JumioApiError ? error : null;
    const reason = apiError?.message ?? "Could not start pickup verification.";

    console.error(
      `[jumio] Pickup start failed for driver ${driverId}: ${reason}` +
        (apiError?.details ? ` Jumio said: ${apiError.details}` : ""),
    );

    return { ok: false, reason };
  }
}

/** Fetch the outcome straight from Jumio. Read-only — nothing is persisted. */
export async function retrievePickupResult(
  accountId: string,
  workflowExecutionId: string,
  client?: JumioClient,
): Promise<PickupResult> {
  const { details } = await retrieveWorkflowWithBackoff(
    accountId,
    workflowExecutionId,
    client ?? new JumioClient(),
  );

  const result = mapWorkflowDetails(details);

  return {
    decision: result.decision,
    riskScore: result.riskScore,
    liveness: result.liveness,
    faceMatch: result.faceMatch,
    capabilities: result.decisionDetails,
    completedAt: result.completedAt?.toISOString() ?? null,
    settled: result.status === "PROCESSED",
  };
}
