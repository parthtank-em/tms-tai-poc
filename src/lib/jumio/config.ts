/**
 * Jumio tenant configuration.
 *
 * Every value here is server-side. Nothing in this file may be imported into a
 * client component — the client secret and callback secret live in it.
 *
 * Hosts follow the per-datacenter pattern Jumio documents:
 *
 *   auth       https://auth.{dc}.jumio.ai/oauth2/token
 *   account    https://account.{dc}.jumio.ai/api/v1/accounts
 *   retrieval  https://retrieval.{dc}.jumio.ai/api/v1/...
 *
 * where `{dc}` is `amer-1` (US), `emea-1` (EU) or `apac-1` (SGP). The derived
 * defaults are a convenience, not an assumption: each one can be overridden
 * outright, because the authoritative values come from the Jumio tenant.
 *
 * @see https://documentation.jumio.ai/docs/developer-resources/API/authorization
 */

import type { JumioAcquisitionChannel, JumioSdkDatacenter } from "./acquisition";

export type JumioDatacenter = "amer-1" | "emea-1" | "apac-1";

const DATACENTERS: readonly JumioDatacenter[] = ["amer-1", "emea-1", "apac-1"];

/** The REST datacenter, in the spelling `<jumio-sdk dc="…">` expects. */
const SDK_DATACENTERS: Record<JumioDatacenter, JumioSdkDatacenter> = {
  "amer-1": "us",
  "emea-1": "eu",
  "apac-1": "sgp",
};

/** Capture-screen language. A constant, not a setting — the SDK has its own language selector. */
export const JUMIO_LOCALE = "en";

/**
 * A configuration problem, not a Jumio problem.
 *
 * Routes translate this into a 503 with a generic message: the operator needs
 * the detail in the server log, the browser must not receive it.
 */
export class JumioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JumioConfigError";
  }
}

export type JumioConfig = {
  clientId: string;
  clientSecret: string;
  datacenter: JumioDatacenter;
  /** OAuth2 token endpoint. */
  authUrl: string;
  /** Account API root, no trailing slash. `POST` here creates a transaction. */
  accountBaseUrl: string;
  /** Retrieval API root, no trailing slash. */
  retrievalBaseUrl: string;
  /** Workflow definition key from the Jumio portal. */
  workflowKey: string;
  /**
   * Workflow definition key for supporting-document checks (Doc Proof).
   *
   * A different workflow from `workflowKey` because it runs different
   * capabilities against a different credential category — see
   * `document-check.ts`. Null when the tenant has not enabled one, which is
   * what the documents screen reports rather than failing at upload time.
   */
  documentWorkflowKey: string | null;
  /** Public HTTPS URL Jumio posts callbacks to, secret already appended. */
  callbackUrl: string;
  /** Shared secret embedded in `callbackUrl`, checked on every delivery. */
  callbackSecret: string;
  /** This app's public origin, used to build the Web Client return URLs. */
  appUrl: string;
  /** Identifies this integration in Jumio's request logs. */
  userAgent: string;
  /** Optional Web Client token lifetime, e.g. `30m`. Jumio's default applies when unset. */
  tokenLifetime: string | null;
  /** Whether the browser embeds the Web SDK or redirects to the Web Client. */
  acquisitionChannel: JumioAcquisitionChannel;
  /** `datacenter` in the spelling the Web SDK's `dc` attribute expects. */
  sdkDatacenter: JumioSdkDatacenter;
};

function read(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function require_(name: string): string {
  const value = read(name);
  if (!value) {
    throw new JumioConfigError(`${name} is not set. See .env.example.`);
  }
  return value;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function resolveDatacenter(): JumioDatacenter {
  const value = read("JUMIO_DATACENTER") ?? "amer-1";

  if (!DATACENTERS.includes(value as JumioDatacenter)) {
    throw new JumioConfigError(
      `JUMIO_DATACENTER must be one of ${DATACENTERS.join(", ")} — got "${value}".`,
    );
  }

  return value as JumioDatacenter;
}

/** Defaults to the SDK; `redirect` falls back to the hosted Web Client without a code change. */
function resolveAcquisitionChannel(): JumioAcquisitionChannel {
  const value = read("NEXT_PUBLIC_JUMIO_ACQUISITION_CHANNEL") ?? "sdk";

  if (value !== "sdk" && value !== "redirect") {
    throw new JumioConfigError(
      `NEXT_PUBLIC_JUMIO_ACQUISITION_CHANNEL must be "sdk" or "redirect" — got "${value}".`,
    );
  }

  return value;
}

/**
 * Resolved configuration, or a `JumioConfigError` naming the missing variable.
 *
 * Read per call rather than cached at module load: a missing variable should
 * fail the one request that needs it, not the whole server boot.
 */
export function getJumioConfig(): JumioConfig {
  const datacenter = resolveDatacenter();
  const callbackSecret = require_("JUMIO_CALLBACK_SECRET");
  const appUrl = stripTrailingSlash(require_("NEXT_PUBLIC_APP_URL"));

  // The callback URL must be publicly reachable, so in development it is the
  // tunnel host rather than the app origin (§23). The shared secret rides in a
  // query parameter because Jumio signs nothing — see callback-auth.ts.
  const callbackBase = stripTrailingSlash(read("JUMIO_CALLBACK_URL") ?? `${appUrl}/api/jumio/callback`);
  const callbackUrl = `${callbackBase}?token=${encodeURIComponent(callbackSecret)}`;

  return {
    clientId: require_("JUMIO_CLIENT_ID"),
    clientSecret: require_("JUMIO_CLIENT_SECRET"),
    datacenter,
    authUrl: read("JUMIO_AUTH_URL") ?? `https://auth.${datacenter}.jumio.ai/oauth2/token`,
    accountBaseUrl: stripTrailingSlash(
      read("JUMIO_API_BASE_URL") ?? `https://account.${datacenter}.jumio.ai`,
    ),
    retrievalBaseUrl: stripTrailingSlash(
      read("JUMIO_RETRIEVAL_BASE_URL") ?? `https://retrieval.${datacenter}.jumio.ai`,
    ),
    workflowKey: require_("JUMIO_WORKFLOW_KEY"),
    documentWorkflowKey: read("JUMIO_DOCUMENT_WORKFLOW_KEY"),
    callbackUrl,
    callbackSecret,
    appUrl,
    userAgent: read("JUMIO_USER_AGENT") ?? "FreightID FreightID-POC/1.0",
    tokenLifetime: read("JUMIO_TOKEN_LIFETIME"),
    acquisitionChannel: resolveAcquisitionChannel(),
    sdkDatacenter: SDK_DATACENTERS[datacenter],
  };
}

/** True when the integration is configured enough to attempt a call. */
export function isJumioConfigured(): boolean {
  try {
    getJumioConfig();
    return true;
  } catch {
    return false;
  }
}

/**
 * True when document checks can run.
 *
 * Stricter than `isJumioConfigured`: the base credentials are not enough,
 * because the document workflow is a separate definition the tenant has to have
 * enabled. Checking it here means the screen can say so up front instead of
 * letting an operator upload a file and then fail.
 */
export function isJumioDocumentCheckConfigured(): boolean {
  try {
    return getJumioConfig().documentWorkflowKey !== null;
  } catch {
    return false;
  }
}
