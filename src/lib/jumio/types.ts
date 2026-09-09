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

/**
 * A credential the workflow should expect, declared at account creation.
 *
 * Only the API acquisition channel needs this. The Web Client asks the user
 * what they are presenting; when *we* upload the file, Jumio has to be told in
 * advance which document template to match it against.
 *
 * `predefinedType: "DEFINED"` means "exactly these values" — the alternative is
 * letting Jumio accept anything, which defeats the point of naming a type.
 */
export type JumioCredentialRequest = {
  category: "ID" | "DOCUMENT" | "SELFIE" | "FACEMAP" | "DATA";
  /** ISO 3166-1 alpha-3 codes. */
  country?: { predefinedType?: "DEFINED"; values: string[] };
  /** Document type codes, e.g. `UB` (utility bill), `BS` (bank statement). */
  type?: { predefinedType?: "DEFINED"; values: string[] };
};

/** `POST /api/v1/accounts` request body. */
export type JumioCreateAccountRequest = {
  /** Opaque internal reference, max 100 chars. Must not contain PII (§8). */
  customerInternalReference: string;
  workflowDefinition: { key: string; credentials?: JumioCredentialRequest[] };
  userReference?: string;
  callbackUrl?: string;
  tokenLifetime?: string;
  web?: { successUrl?: string; errorUrl?: string; locale?: string };
  userConsent?: JumioUserConsent;
};

/**
 * One credential in the account-create reply, with the URLs to acquire it.
 *
 * `api.token` is a **transaction-scoped** token, not the tenant bearer: it
 * authorizes uploads for this workflow execution and nothing else. The part
 * URLs are pre-parameterized with the account, workflow and credential ids, so
 * they are used verbatim and never rebuilt from a template.
 */
export type JumioCredentialResponse = {
  id?: string;
  category?: string;
  api?: {
    token?: string;
    /** Keyed by part: `document` for a DOCUMENT credential, `front`/`back` for an ID. */
    parts?: Record<string, string | undefined>;
    /** `PUT` here once every part is uploaded, to start processing. */
    workflowExecution?: string;
  };
};

/** `POST /api/v1/accounts` response. */
export type JumioCreateAccountResponse = {
  timestamp?: string;
  account?: { id?: string };
  web?: { href?: string };
  sdk?: { token?: string };
  workflowExecution?: { id?: string; credentials?: JumioCredentialResponse[] };
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

/**
 * `capabilities.extraction[].data` for a DOCUMENT credential.
 *
 * Wider and looser than `JumioExtractionData` above, because supporting
 * documents are not one shape: a utility bill carries an address and an issuer,
 * a bank statement carries an account holder, and Jumio adds document types
 * without changing the API version. Everything here is optional, and the
 * service stores the whole object alongside the mapped columns so a field we
 * did not anticipate is still visible.
 */
export type JumioDocumentExtractionData = {
  type?: string;
  subType?: string;
  issuingCountry?: string;
  issuingDate?: string;
  expiryDate?: string;
  documentNumber?: string;
  issuer?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    subdivision?: string;
    postalCode?: string;
    country?: string;
    formattedAddress?: string;
  };
  /** Jumio may return fields this type does not name. */
  [key: string]: unknown;
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
    extraction?: JumioCapability<JumioExtractionData & JumioDocumentExtractionData>[];
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
