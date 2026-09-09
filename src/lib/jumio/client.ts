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

/**
 * A Jumio API call that did not succeed.
 *
 * `message` is safe to show a user. `details` is Jumio's own explanation and is
 * for the server log only — it is what turns "HTTP 400" into something
 * actionable. It is never returned to the browser and never stored on the
 * verification row.
 */
export class JumioApiError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly details: string | null;

  constructor(message: string, status: number | null, retryable: boolean, details: string | null = null) {
    super(message);
    this.name = "JumioApiError";
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

/** Enough of Jumio's error to diagnose it, not enough to fill a log with a payload. */
const MAX_DETAIL_CHARS = 1_000;

/**
 * Multipart field name for a credential part upload.
 *
 * Jumio's public documentation describes the upload endpoints and their limits
 * but does not print the field name, so this is the one detail here taken from
 * their support guidance rather than a published page. It is a named constant
 * because if a tenant's API disagrees, this is the single line to change — and
 * the 400 that would result carries Jumio's own explanation into the log via
 * `JumioApiError.details`.
 */
const UPLOAD_FIELD_NAME = "file";

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

    return this.send<T>(url, init, token, retryOn401 ? () => this.request<T>(url, init, false) : null);
  }

  /**
   * One HTTP exchange with an explicit bearer token.
   *
   * Split out from `request` because credential uploads authenticate with the
   * **transaction** token Jumio returns in the account reply, not the tenant
   * token. That token cannot be refreshed — it belongs to one workflow
   * execution — so those calls pass no `onUnauthorized` and a 401 surfaces
   * as-is rather than triggering a pointless re-auth.
   */
  private async send<T>(
    url: string,
    init: RequestInit,
    token: string,
    onUnauthorized: (() => Promise<T>) | null,
  ): Promise<T> {
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

    if (response.status === 401 && onUnauthorized) {
      // The cached token was revoked or rotated out from under us.
      invalidateJumioAccessToken();
      return onUnauthorized();
    }

    if (!response.ok) {
      let details = this.redact(await this.readErrorBody(response));

      // A 405 means we chose the wrong verb, and the endpoint already knows the
      // right one — it is in `Allow`. Carrying it into the log turns "which
      // method does this take?" from a guess into something the error answers.
      if (response.status === 405) {
        const allowed = response.headers.get("allow");
        if (allowed) details = `${details ?? ""} Allowed methods: ${allowed}.`.trim();
      }

      throw new JumioApiError(
        `Jumio returned HTTP ${response.status}.`,
        response.status,
        isRetryableStatus(response.status),
        details,
      );
    }

    if (response.status === 204) {
      return {} as T;
    }

    // Upload and finalize answer 200 with an empty body. Read as text first so
    // that is a success rather than a JSON parse failure.
    const text = await response.text();

    if (!text.trim()) {
      return {} as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new JumioApiError("Jumio returned a malformed response.", response.status, false);
    }
  }

  /** Jumio explains a 4xx in the body; a failure to read it must not mask the error. */
  private async readErrorBody(response: Response): Promise<string | null> {
    try {
      const text = (await response.text()).trim();
      return text ? text.slice(0, MAX_DETAIL_CHARS) : null;
    } catch {
      return null;
    }
  }

  /**
   * Strip our own secrets out before anything is logged.
   *
   * A validation error can echo the request back, and the request carries the
   * callback URL with its shared secret in the query string. That must not
   * reach a log line.
   */
  private redact(text: string | null): string | null {
    if (!text) return null;

    return text
      .split(this.config.callbackSecret)
      .join("[redacted-callback-secret]")
      .split(this.config.clientSecret)
      .join("[redacted-client-secret]");
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
   * Upload one credential part — the image or PDF itself.
   *
   * `url` is taken verbatim from `workflowExecution.credentials[].api.parts` in
   * the account reply; it already carries the account, workflow and credential
   * ids. Building it from a template here would mean guessing a host, and the
   * upload host is not the account host.
   *
   * `Content-Type` is deliberately not set: `fetch` derives it from the
   * `FormData` body, including the multipart boundary. Setting it by hand omits
   * the boundary and Jumio rejects the request.
   *
   * `POST`, not `PUT` — the upload endpoint answers a PUT with 405. Finalize,
   * just below, *is* a PUT; the two differ, which is easy to get backwards.
   */
  async uploadCredentialPart(
    url: string,
    token: string,
    file: Blob,
    fileName: string,
  ): Promise<unknown> {
    const form = new FormData();
    form.append(UPLOAD_FIELD_NAME, file, fileName);

    return this.send<unknown>(url, { method: "POST", body: form }, token, null);
  }

  /**
   * Start processing, now that every part is uploaded.
   *
   * The API acquisition channel has no user pressing "submit", so nothing would
   * otherwise tell Jumio the transaction is complete — without this call the
   * workflow sits at `ACQUIRED` until its token expires.
   */
  async finalizeWorkflowExecution(url: string, token: string): Promise<unknown> {
    return this.send<unknown>(
      url,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      token,
      null,
    );
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
