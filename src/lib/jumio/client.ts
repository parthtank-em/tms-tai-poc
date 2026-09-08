import { getJumioAccessToken, invalidateJumioAccessToken, JumioAuthError } from "./auth";
import { getJumioConfig, type JumioConfig } from "./config";

import type {
  JumioCreateAccountRequest,
  JumioCreateAccountResponse,
  JumioWorkflowDetails,
} from "./types";

/**
 * Jumio REST client (§7).
 *
 * One place that knows about hosts, bearer tokens and error shapes, so no route
 * handler ever calls `fetch` against Jumio directly.
 *
 * Two rules run through everything below:
 *
 * - **Nothing sensitive is logged.** Not the token, not the client secret, not
 *   the response bodies (extraction results are PII). Errors carry a status and
 *   a short reason, and that is all.
 * - **A 401 is retried exactly once**, after dropping the cached token. Beyond
 *   once it is a credential problem, and retrying would only burn rate limit.
 */

const TIMEOUT_MS = 30_000;

/** A Jumio API call that did not succeed. The message is safe to show a user. */
export class JumioApiError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = "JumioApiError";
    this.status = status;
    this.retryable = retryable;
  }
}

/** 5xx and 429 are worth another attempt; a 4xx is our own bad request. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class JumioClient {
  private readonly config: JumioConfig;

  constructor(config: JumioConfig = getJumioConfig()) {
    this.config = config;
  }

  private async request<T>(url: string, init: RequestInit, retryOn401 = true): Promise<T> {
    let token: string;

    try {
      token = await getJumioAccessToken(this.config);
    } catch (cause) {
      if (cause instanceof JumioAuthError) {
        throw new JumioApiError(
          "Jumio authentication unavailable.",
          cause.status,
          cause.status === null || isRetryableStatus(cause.status),
        );
      }
      throw cause;
    }

    let response: Response;

    try {
      response = await fetch(url, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": this.config.userAgent,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "unknown error";
      throw new JumioApiError(`Could not reach Jumio: ${reason}`, null, true);
    }

    if (response.status === 401 && retryOn401) {
      // The cached token was revoked or rotated out from under us.
      invalidateJumioAccessToken();
      return this.request<T>(url, init, false);
    }

    if (!response.ok) {
      throw new JumioApiError(
        `Jumio returned HTTP ${response.status}.`,
        response.status,
        isRetryableStatus(response.status),
      );
    }

    if (response.status === 204) {
      return {} as T;
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new JumioApiError("Jumio returned a malformed response.", response.status, false);
    }
  }

  /**
   * `POST /api/v1/accounts` — creates the account and the workflow execution in
   * one call, and returns the Web Client URL to redirect the driver to.
   */
  async createAccount(body: JumioCreateAccountRequest): Promise<JumioCreateAccountResponse> {
    return this.request<JumioCreateAccountResponse>(`${this.config.accountBaseUrl}/api/v1/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * `GET /api/v1/accounts/{accountId}/workflow-executions/{workflowExecutionId}`
   * — the full result: decision, risk score, and each capability's outcome.
   */
  async retrieveWorkflow(accountId: string, workflowExecutionId: string): Promise<JumioWorkflowDetails> {
    const url =
      `${this.config.retrievalBaseUrl}/api/v1/accounts/${encodeURIComponent(accountId)}` +
      `/workflow-executions/${encodeURIComponent(workflowExecutionId)}`;

    return this.request<JumioWorkflowDetails>(url, { method: "GET" });
  }
}
