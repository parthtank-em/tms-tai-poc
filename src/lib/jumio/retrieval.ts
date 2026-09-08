import { JumioApiError, JumioClient } from "./client";

import type { JumioWorkflowDetails } from "./types";

/**
 * Retrieval with controlled backoff (§13, §14).
 *
 * Jumio processing is asynchronous, and a callback can land a moment before the
 * workflow is fetchable. The answer is a handful of spaced attempts, not a
 * polling loop: Jumio sends a further callback when the workflow reaches its
 * next state, so this only has to survive a brief gap, never wait out the whole
 * verification.
 *
 * Only retryable failures are retried — a 429, a 5xx, a network error, or the
 * 404 that means "not visible yet". A 400 or 403 is our mistake and repeating
 * it just spends rate limit.
 */

/** Delays between attempts. Four attempts, ~22s of patience in total. */
const BACKOFF_MS = [1_000, 3_000, 8_000, 10_000] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A 404 here means "not ready yet" far more often than "does not exist". */
function isNotReady(error: JumioApiError): boolean {
  return error.retryable || error.status === 404;
}

export async function retrieveWorkflowWithBackoff(
  accountId: string,
  workflowExecutionId: string,
  client: JumioClient = new JumioClient(),
  maxAttempts = BACKOFF_MS.length,
): Promise<{ details: JumioWorkflowDetails; attempts: number }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const details = await client.retrieveWorkflow(accountId, workflowExecutionId);
      return { details, attempts: attempt };
    } catch (error) {
      lastError = error;

      const worthRetrying = error instanceof JumioApiError && isNotReady(error);
      if (!worthRetrying || attempt === maxAttempts) break;

      await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    }
  }

  throw lastError;
}
