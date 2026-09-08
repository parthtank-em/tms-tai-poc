import { getJumioConfig, type JumioConfig } from "./config";

/**
 * Jumio OAuth 2.0 client-credentials flow (§2.1, §6).
 *
 * Basic auth appears exactly once, here, to *obtain* a bearer token — that is
 * the documented flow, and it is not the same thing as the legacy Basic-auth
 * API integration the plan rules out. Every API call afterwards is Bearer.
 *
 * Tokens are valid for 3600s and `oauth2/token` is rate limited to 10/s, so the
 * token is cached in memory and refreshed early. Concurrent callers share one
 * in-flight request rather than each starting their own.
 *
 * In-memory is right for a POC and only for a POC: every serverless instance
 * keeps its own copy, so a fleet of N instances holds N tokens.
 *
 * @see https://documentation.jumio.ai/docs/developer-resources/API/authorization
 */

/** Refresh this far before the stated expiry, per Jumio's guidance. */
const EXPIRY_SKEW_MS = 120_000;

/** Fallback when the response omits `expires_in`. Jumio's documented default. */
const DEFAULT_LIFETIME_SECONDS = 3600;

const TIMEOUT_MS = 15_000;

type CachedToken = { token: string; expiresAt: number };

let cached: CachedToken | null = null;
let inFlight: Promise<string> | null = null;

/** A sanitized OAuth failure. The message is safe to log; it never carries the credential. */
export class JumioAuthError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "JumioAuthError";
    this.status = status;
  }
}

function isFresh(token: CachedToken | null): token is CachedToken {
  return token !== null && Date.now() < token.expiresAt - EXPIRY_SKEW_MS;
}

async function requestToken(config: JumioConfig): Promise<CachedToken> {
  // Basic credentials for the token call only, built per request so the encoded
  // secret is never held in a module-level variable.
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64");

  let response: Response;

  try {
    response = await fetch(config.authUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": config.userAgent,
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "unknown error";
    throw new JumioAuthError(`Could not reach the Jumio token endpoint: ${reason}`);
  }

  if (!response.ok) {
    // The body can echo request details, so it is deliberately not included.
    throw new JumioAuthError(
      `Jumio token request rejected with HTTP ${response.status}.`,
      response.status,
    );
  }

  let payload: { access_token?: unknown; expires_in?: unknown; token_type?: unknown };

  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new JumioAuthError("Jumio token response was not JSON.", response.status);
  }

  const token = typeof payload.access_token === "string" ? payload.access_token : null;

  if (!token) {
    throw new JumioAuthError("Jumio token response contained no access_token.", response.status);
  }

  const lifetime =
    typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in
      : DEFAULT_LIFETIME_SECONDS;

  return { token, expiresAt: Date.now() + lifetime * 1000 };
}

/**
 * A valid bearer token, from cache when possible.
 *
 * Never log the return value.
 */
export async function getJumioAccessToken(config: JumioConfig = getJumioConfig()): Promise<string> {
  if (isFresh(cached)) {
    return cached.token;
  }

  // Collapse a stampede: the first caller fetches, the rest await the same
  // promise. Without this a burst of requests would each spend a rate-limit
  // slot on an identical token.
  inFlight ??= requestToken(config)
    .then((token) => {
      cached = token;
      return token.token;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Drop the cached token after a 401.
 *
 * A token can be revoked before it expires, in which case the cache is
 * confidently wrong. Callers invalidate and retry exactly once.
 */
export function invalidateJumioAccessToken(): void {
  cached = null;
}

/** Test seam. Not for application code. */
export function __resetJumioAuthCacheForTests(): void {
  cached = null;
  inFlight = null;
}
