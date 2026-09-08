/**
 * Jumio wire types.
 *
 * Transcribed from the current Jumio API documentation, not from older
 * examples. Field names are Jumio's own so a future diff against their docs is
 * a straight comparison; everything is optional because a response we have not
 * seen must not crash the mapper.
 *
 * These types describe the **wire**. Nothing outside `src/lib/jumio` should
 * import them — the rest of FreightID consumes the mapped result instead (§16).
 */

/** `workflowExecution.status`. Jumio may add values, so the mapper tolerates unknowns. */
export type JumioWorkflowStatus =
  | "INITIATED"
  | "ACQUISITION_STARTED"
  | "ACQUIRED"
  | "PROCESSED"
  | "SESSION_EXPIRED"
  | "TOKEN_EXPIRED";

/** `decision.type`. */
export type JumioDecisionType = "PASSED" | "WARNING" | "REJECTED" | "NOT_EXECUTED";

/**
 * Consent block sent on account creation (§2.4).
 *
 * `userIp` and `userLocation.country` are mandatory on Jumio's side, and
 * `state` is mandatory when the country is `USA`. `country` is ISO 3166-1
 * alpha-3.
 */
export type JumioUserConsent = {
  userIp?: string;
  userLocation: { country: string; state?: string };
  consent: { obtained: "yes" | "no"; obtainedAt: string };
};

/** `POST /api/v1/accounts` request body. */
export type JumioCreateAccountRequest = {
  /** Opaque internal reference, max 100 chars. Must not contain PII (§8). */
  customerInternalReference: string;
  workflowDefinition: { key: string; credentials?: unknown[] };
  userReference?: string;
  callbackUrl?: string;
  tokenLifetime?: string;
  web?: { successUrl?: string; errorUrl?: string; locale?: string };
  userConsent?: JumioUserConsent;
};

/** `POST /api/v1/accounts` response. */
export type JumioCreateAccountResponse = {
  timestamp?: string;
  account?: { id?: string };
  web?: { href?: string };
  sdk?: { token?: string };
  workflowExecution?: { id?: string; credentials?: unknown[] };
};

/** The callback body Jumio POSTs (§11). Identifiers and a status — nothing else. */
export type JumioCallbackPayload = {
  callbackSentAt?: string;
  userReference?: string;
  customerInternalReference?: string;
  workflowExecution?: {
    id?: string;
    href?: string;
    definitionKey?: string;
    status?: string;
  };
  account?: { id?: string; href?: string };
};

type JumioCapabilityDecision = {
  type?: JumioDecisionType;
  details?: { label?: string };
};

type JumioCapability<TData = Record<string, unknown>> = {
  id?: string;
  credentials?: { id?: string; category?: string }[];
  decision?: JumioCapabilityDecision;
  data?: TData;
};

/** `capabilities.extraction[].data` — the document fields we keep. */
export type JumioExtractionData = {
  type?: string;
  subType?: string;
  issuingCountry?: string;
  firstName?: string;
  lastName?: string;
  /** `YYYY-MM-DD`. */
  dateOfBirth?: string;
  /** `YYYY-MM-DD`. */
  expiryDate?: string;
  /** `YYYY-MM-DD`. */
  issuingDate?: string;
  documentNumber?: string;
  state?: string;
};

/** `GET /api/v1/accounts/{accountId}/workflow-executions/{workflowExecutionId}`. */
export type JumioWorkflowDetails = {
  workflow?: {
    id?: string;
    status?: string;
    definitionKey?: string;
    userReference?: string;
    customerInternalReference?: string;
  };
  account?: { id?: string };
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  decision?: {
    type?: JumioDecisionType;
    details?: { label?: string };
    /** 0 (no risk) to 100. `-1` means the workflow never executed. */
    risk?: { score?: number };
  };
  capabilities?: {
    extraction?: JumioCapability<JumioExtractionData>[];
    /** Selfie-to-ID face match. Jumio calls it "similarity". */
    similarity?: JumioCapability<{ similarity?: string }>[];
    liveness?: JumioCapability<{ type?: string }>[];
    usability?: JumioCapability[];
    dataChecks?: JumioCapability[];
    imageChecks?: JumioCapability[];
  };
  /**
   * Present in the response, deliberately unused: `credentials[].parts[].href`
   * points at the ID and selfie images, which FreightID does not fetch or store
   * (§2.5).
   */
  credentials?: unknown[];
};
