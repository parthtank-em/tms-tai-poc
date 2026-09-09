import { JumioApiError, JumioClient } from "./client";
import { getJumioConfig, JumioConfigError, type JumioConfig } from "./config";
import { mapDocumentWorkflowDetails } from "./document-mapper";
import { mapWorkflowStatus } from "./mapper";
import { retrieveWorkflowWithBackoff } from "./retrieval";

import type { Prisma } from "@/generated/prisma/client";
import type { JumioVerificationStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

import type { JumioCreateAccountRequest, JumioCredentialResponse } from "./types";

/**
 * Document checks: upload a file, get it verified, read back what Jumio
 * extracted.
 *
 * This is the **API acquisition channel**, and that is the whole difference
 * from `verification.ts`. There, Jumio's Web Client collects the document from
 * the driver and we never touch the bytes. Here there is no user journey at
 * all: an operator hands us a file, and FreightID performs the four steps the
 * Web Client would otherwise perform on its own —
 *
 *   1. create the account, declaring a DOCUMENT credential up front so Jumio
 *      knows which template to match;
 *   2. upload the file to the part URL that came back;
 *   3. finalize the workflow, because nothing else will;
 *   4. wait for the callback, then retrieve the result.
 *
 * Steps 1-3 are synchronous and happen inside the upload request. Step 4 is
 * not: Jumio processes asynchronously, so the result arrives later, exactly as
 * it does for an identity verification.
 *
 * **The uploaded file is never persisted.** It exists as bytes in this process
 * for the duration of step 2 and is then dropped. FreightID stores what Jumio
 * read off it, not the document itself — the same rule §2.5 applies to ID
 * images, for the same reason.
 */

/** Jumio's documented ceiling for a credential upload. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** Jumio accepts these three and nothing else. */
export const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;

/**
 * Document types this screen offers, from Jumio's supported-document list.
 *
 * Not the full catalogue — it is the address- and identity-adjacent subset a
 * freight operator actually asks a driver for. Which of these a given tenant
 * can run still depends on the workflow Jumio enabled.
 */
export const DOCUMENT_TYPES = [
  { code: "UB", label: "Utility bill" },
  { code: "BS", label: "Bank statement" },
  { code: "CCS", label: "Credit card statement" },
  { code: "PB", label: "Phone bill" },
  { code: "CB", label: "Council bill" },
  { code: "LAG", label: "Lease agreement" },
  { code: "TR", label: "Tax return" },
  { code: "VT", label: "Vehicle title" },
  { code: "IC", label: "Insurance card" },
  { code: "SSC", label: "Social security card" },
] as const;

export function isKnownDocumentType(code: string): boolean {
  return DOCUMENT_TYPES.some((entry) => entry.code === code);
}

export type StartDocumentCheckInput = {
  file: Blob;
  fileName: string;
  mimeType: string;
  /** A code from `DOCUMENT_TYPES`, e.g. `UB`. */
  documentType: string;
  /** ISO 3166-1 alpha-3. */
  country: string;
};

export type StartDocumentCheckResult =
  | { ok: true; checkId: string }
  | { ok: false; reason: string; checkId: string | null };

/**
 * Pull the DOCUMENT credential's upload URLs out of the account reply.
 *
 * Selected by category rather than by position: the reply lists one entry per
 * credential the workflow declares, and reading index zero would break the day
 * the workflow gains a second one.
 */
function documentCredential(credentials: JumioCredentialResponse[] | undefined) {
  const credential = credentials?.find((entry) => entry.category === "DOCUMENT") ?? credentials?.[0];

  if (!credential?.api) return null;

  // Jumio keys the part `document` for this category. The fallback covers a
  // single-part credential returned under a name we did not anticipate — the
  // URL is what matters, not what it is filed under.
  const parts = credential.api.parts ?? {};
  const uploadUrl = parts.document ?? Object.values(parts).find((value) => Boolean(value)) ?? null;

  if (!uploadUrl || !credential.api.workflowExecution || !credential.api.token) return null;

  return {
    id: credential.id ?? null,
    token: credential.api.token,
    uploadUrl,
    finalizeUrl: credential.api.workflowExecution,
  };
}

/**
 * Run steps 1-3: create, upload, finalize.
 *
 * The local row is created first so its id can be the
 * `customerInternalReference` — an opaque UUID, no PII (§8) — and so a failure
 * at any later step lands somewhere visible instead of vanishing.
 */
export async function startDocumentCheck(
  input: StartDocumentCheckInput,
  client?: JumioClient,
): Promise<StartDocumentCheckResult> {
  let config: JumioConfig;

  try {
    config = getJumioConfig();
  } catch (error) {
    if (error instanceof JumioConfigError) {
      console.error(`[jumio] Document check not configured: ${error.message}`);
      return { ok: false, reason: "Document verification is not available right now.", checkId: null };
    }
    throw error;
  }

  if (!config.documentWorkflowKey) {
    console.error("[jumio] JUMIO_DOCUMENT_WORKFLOW_KEY is not set. See .env.example.");
    return { ok: false, reason: "Document verification is not configured.", checkId: null };
  }

  const check = await prisma.documentCheck.create({
    data: {
      status: "INITIATED",
      jumioWorkflowKey: config.documentWorkflowKey,
      requestedType: input.documentType,
      requestedCountry: input.country,
      fileName: input.fileName,
      fileMimeType: input.mimeType,
      fileSizeBytes: input.file.size,
    },
    select: { id: true },
  });

  const body: JumioCreateAccountRequest = {
    customerInternalReference: check.id,
    workflowDefinition: {
      key: config.documentWorkflowKey,
      credentials: [
        {
          category: "DOCUMENT",
          country: { predefinedType: "DEFINED", values: [input.country] },
          type: { predefinedType: "DEFINED", values: [input.documentType] },
        },
      ],
    },
    callbackUrl: config.callbackUrl,
  };

  const jumio = client ?? new JumioClient(config);

  try {
    const response = await jumio.createAccount(body);

    const accountId = response.account?.id ?? null;
    const workflowId = response.workflowExecution?.id ?? null;
    const credential = documentCredential(response.workflowExecution?.credentials);

    if (!accountId || !workflowId || !credential) {
      throw new JumioApiError(
        "Jumio response was missing the account, workflow or document upload URL.",
        null,
        false,
      );
    }

    await prisma.documentCheck.update({
      where: { id: check.id },
      data: {
        jumioAccountId: accountId,
        jumioWorkflowId: workflowId,
        jumioCredentialId: credential.id,
        status: "ACQUISITION_STARTED",
      },
    });

    await jumio.uploadCredentialPart(
      credential.uploadUrl,
      credential.token,
      input.file,
      input.fileName,
    );

    await jumio.finalizeWorkflowExecution(credential.finalizeUrl, credential.token);

    // ACQUIRED, not PROCESSED: Jumio now has the document, and that is all we
    // know. The decision arrives on the callback.
    await prisma.documentCheck.update({
      where: { id: check.id },
      data: { status: "ACQUIRED" },
    });

    return { ok: true, checkId: check.id };
  } catch (error) {
    const apiError = error instanceof JumioApiError ? error : null;
    const reason = apiError?.message ?? "Could not submit the document to Jumio.";

    await prisma.documentCheck.update({
      where: { id: check.id },
      data: { status: "FAILED", error: reason, completedAt: new Date() },
    });

    // The sanitized reason goes to the browser; Jumio's own explanation — which
    // is what actually says *why* a 400 happened — goes to the log only.
    console.error(
      `[jumio] Document check ${check.id} failed: ${reason}` +
        (apiError?.details ? ` Jumio said: ${apiError.details}` : ""),
    );

    return { ok: false, reason, checkId: check.id };
  }
}

/** Terminal states. A check here will not change again. */
const TERMINAL = ["PROCESSED", "SESSION_EXPIRED", "TOKEN_EXPIRED", "FAILED"] as const;

export function isDocumentCheckSettled(status: string): boolean {
  return (TERMINAL as readonly string[]).includes(status);
}

/** How far along each state is, for the no-going-backwards rule. */
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

/**
 * Advance a check from a callback status alone.
 *
 * The same rule as identity verifications: callbacks can arrive out of order,
 * so a late `ACQUIRED` must not undo a `PROCESSED`. Interim states carry no
 * result — the extracted data comes from retrieval.
 */
export async function applyDocumentCallbackStatus(
  checkId: string,
  rawStatus: string,
): Promise<void> {
  const incoming = mapWorkflowStatus(rawStatus);

  const current = await prisma.documentCheck.findUnique({
    where: { id: checkId },
    select: { status: true },
  });

  if (!current || PROGRESS[incoming] <= PROGRESS[current.status]) return;

  await prisma.documentCheck.update({
    where: { id: checkId },
    data: {
      status: incoming,
      ...(isDocumentCheckSettled(incoming) && incoming !== "PROCESSED"
        ? { completedAt: new Date() }
        : {}),
    },
  });
}

/**
 * Fetch the result from Jumio and persist the extracted data.
 *
 * Called from the callback handler, and also from the status endpoint as a
 * fallback — in development the callback URL is a tunnel that may not be
 * running, and a POC that only works when a tunnel is up is not much of a
 * demonstration. Both paths are idempotent.
 */
export async function syncDocumentCheckFromJumio(
  checkId: string,
  client?: JumioClient,
): Promise<void> {
  const check = await prisma.documentCheck.findUnique({
    where: { id: checkId },
    select: {
      id: true,
      jumioAccountId: true,
      jumioWorkflowId: true,
      retrievalAttempts: true,
      decision: true,
    },
  });

  if (!check?.jumioAccountId || !check.jumioWorkflowId) return;

  try {
    const { details, attempts } = await retrieveWorkflowWithBackoff(
      check.jumioAccountId,
      check.jumioWorkflowId,
      client ?? new JumioClient(),
    );

    const result = mapDocumentWorkflowDetails(details);
    const settled = result.status === "PROCESSED";

    await prisma.documentCheck.update({
      where: { id: check.id },
      data: {
        status: result.status,
        decision: result.decision,
        riskScore: result.riskScore,
        documentType: result.documentType,
        documentSubType: result.documentSubType,
        issuer: result.issuer,
        extractedName: result.name,
        addressLine1: result.addressLine1,
        addressLine2: result.addressLine2,
        addressCity: result.addressCity,
        addressSubdivision: result.addressSubdivision,
        addressPostalCode: result.addressPostalCode,
        addressCountry: result.addressCountry,
        formattedAddress: result.formattedAddress,
        documentNumber: result.documentNumber,
        issuingDate: result.issuingDate,
        expiryDate: result.expiryDate,
        extractedData: (result.extractedData ?? undefined) as Prisma.InputJsonValue | undefined,
        decisionDetails: result.decisionDetails as Prisma.InputJsonValue,
        retrievalAttempts: check.retrievalAttempts + attempts,
        retrievedAt: new Date(),
        error: null,
        ...(settled ? { completedAt: result.completedAt ?? new Date() } : {}),
      },
    });
  } catch (error) {
    const reason =
      error instanceof JumioApiError ? error.message : "Could not retrieve the document result.";

    // Not being able to read the answer is not the same as the document
    // failing. The row goes back to PROCESSING so the screen keeps saying "we
    // are waiting" rather than showing a rejection Jumio never issued (§21).
    await prisma.documentCheck.update({
      where: { id: check.id },
      data: {
        retrievalAttempts: { increment: 1 },
        error: reason,
        ...(check.decision ? {} : { status: "PROCESSING", completedAt: null }),
      },
    });

    console.error(`[jumio] Retrieval failed for document check ${check.id}: ${reason}`);
  }
}
