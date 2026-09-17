/**
 * Client for the FMCSA insurance filings published on data.transportation.gov.
 *
 * This is a different service from the QCMobile API in `client.ts`: QCMobile has
 * no insurance resource, so the filings come from the Socrata open-data portal
 * instead — dataset `c5y8-a4uz`, "Motus Insur - All With History". No webKey, no
 * account; Socrata throttles anonymous callers by IP, which is what the optional
 * `SOCRATA_APP_TOKEN` below raises.
 *
 * Two things about the data itself drive most of the code here:
 *
 * 1. **Rows repeat.** The published extract is a flattened join, so the same
 *    filing comes back two, three, twelve times. Deduping is not tidying — an
 *    undeduped table shows the same policy four times and looks like four
 *    policies.
 * 2. **There is no cancellation date.** The dataset carries "active or pending"
 *    filings only, and nothing in a row says which of a carrier's filings is the
 *    one in force today. So this module does not claim one is: it flags the
 *    newest filing within each coverage type + class, which is as far as the
 *    columns actually support, and leaves the rest visible.
 */

import { normalizeDotNumber } from "./client";

const DATASET_URL = "https://data.transportation.gov/resource/c5y8-a4uz.json";

const TIMEOUT_MS = 15_000;

/**
 * Socrata pages at 1000 by default. A carrier with more filings than this is not
 * a case the POC needs to page through, but the cap is explicit so a truncated
 * result is a decision rather than a default that changed under us.
 */
const ROW_LIMIT = 500;

// --- Code lookups ----------------------------------------------------------

/**
 * Labels from the dataset's own data dictionary (the column descriptions on
 * https://data.transportation.gov/api/views/c5y8-a4uz).
 *
 * Every label is shown next to its raw code, never instead of it: older filings
 * carry combinations the dictionary does not explain — BMC-82 filed under type 3
 * ("Bond"), for one — and swallowing the code would hide that.
 */
const FORM_LABELS: Record<string, string> = {
  "34": "Cargo",
  "82": "BI&PD",
  "83": "Cargo",
  "84": "Property Broker's Surety Bond",
  "85": "Property Broker's Trust Fund Agreement",
  "91": "BI&PD",
  "91X": "BI&PD, Primary/Excess",
};

const TYPE_LABELS: Record<string, string> = {
  "1": "BI&PD",
  "2": "Cargo",
  "3": "Bond",
  "4": "Trust Fund",
};

const CLASS_LABELS: Record<string, string> = {
  P: "Primary",
  E: "Excess",
  "1": "Full Security Limits — §1043.2(b)(1)",
  "2": "Full Security Limits — §1043.2(b)(2)",
};

// --- Response shape --------------------------------------------------------

export type FmcsaInsurancePolicy = {
  docketNumber: string | null;
  policyNumber: string | null;
  insuranceCompanyName: string | null;
  /** As filed, e.g. "BMC-91X". */
  formCode: string | null;
  formLabel: string | null;
  typeCode: string | null;
  typeLabel: string | null;
  classCode: string | null;
  classLabel: string | null;
  /** Dollars, as the dataset sends them — see `parseAmount`. */
  maxCoverageAmount: string | null;
  underlyingLimitAmount: string | null;
  /** ISO `YYYY-MM-DD`; the dataset sends `YYYYMMDD`. */
  effectiveDate: string | null;
  /** Date FMCSA received the filing, ISO `YYYY-MM-DD`. */
  filedDate: string | null;
  /**
   * Newest of this carrier's filings of the same type and class, by effective
   * date and then by the date FMCSA received it. Primary and excess BI&PD
   * coexist, which is why class is part of the grouping — flagging only one per
   * type would bury a live excess policy.
   */
  isLatestForCoverage: boolean;
};

export type FmcsaInsuranceFailure =
  /** The input was not a USDOT number, so no call was made. */
  | "invalid-dot"
  /** Non-2xx, or a body that was not the expected array. */
  | "upstream"
  /** DNS, TLS, timeout — the request never produced a response. */
  | "network";

export type FmcsaInsuranceResult =
  | {
      ok: true;
      /** Deduped and sorted. Empty means the carrier has no filings on record. */
      policies: FmcsaInsurancePolicy[];
      /** The response body verbatim, for the raw JSON view. */
      raw: unknown[];
      /** How many rows the dataset returned, duplicates included. */
      rowCount: number;
    }
  | { ok: false; failure: FmcsaInsuranceFailure; message: string };

// --- Parsing ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

/** `"20221031"` → `"2022-10-31"`. Anything else stays null rather than guessing. */
export function parseFiledDate(value: unknown): string | null {
  const digits = asString(value);
  if (!digits || !/^\d{8}$/.test(digits)) return null;

  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/**
 * The column description calls these amounts "in thousands", but every live
 * value contradicts it: cargo minimums arrive as `5000.00` for the $5,000 they
 * are, BI&PD as `1000000.00` for $1M. They are dollars, and are passed through
 * as a numeric string so the UI can group the digits without a float rounding a
 * limit that a broker is going to read off the screen.
 */
export function parseAmount(value: unknown): string | null {
  const text = asString(value);
  if (!text || !/^-?\d+(\.\d+)?$/.test(text)) return null;

  // `.00` is on every value in the dataset and says nothing; anything else stays.
  return text.replace(/\.0+$/, "");
}

/** A filing before it is known whether it is the newest of its coverage. */
type Filing = Omit<FmcsaInsurancePolicy, "isLatestForCoverage">;

/** Strips the `BMC-` prefix the form codes are filed with, for the label lookup. */
function formLabel(formCode: string | null): string | null {
  if (!formCode) return null;
  return FORM_LABELS[formCode.replace(/^BMC-?/i, "").toUpperCase()] ?? null;
}

function normalizePolicy(raw: Record<string, unknown>): Filing {
  const formCode = asString(raw.ins_form_code);
  const typeCode = asString(raw.ins_type_code);
  const classCode = asString(raw.ins_class_code);

  return {
    docketNumber: asString(raw.docket_number),
    policyNumber: asString(raw.policy_no),
    insuranceCompanyName: asString(raw.insurance_company_name),
    formCode,
    formLabel: formLabel(formCode),
    typeCode,
    typeLabel: typeCode ? (TYPE_LABELS[typeCode] ?? null) : null,
    classCode,
    classLabel: classCode ? (CLASS_LABELS[classCode.toUpperCase()] ?? null) : null,
    maxCoverageAmount: parseAmount(raw.max_cov_amount),
    underlyingLimitAmount: parseAmount(raw.underl_lim_amount),
    effectiveDate: parseFiledDate(raw.effective_date),
    filedDate: parseFiledDate(raw.trans_date),
  };
}

/** Identity of a filing, for collapsing the extract's repeated rows. */
function policyKey(policy: Filing): string {
  // JSON rather than a delimiter: a policy number is free text, and any
  // separator picked here could turn up inside one and merge two filings.
  return JSON.stringify([
    policy.docketNumber,
    policy.policyNumber,
    policy.insuranceCompanyName,
    policy.formCode,
    policy.typeCode,
    policy.classCode,
    policy.maxCoverageAmount,
    policy.underlyingLimitAmount,
    policy.effectiveDate,
    policy.filedDate,
  ]);
}

/** Coverage a filing belongs to — primary and excess of one type are separate. */
function coverageKey(policy: Filing): string {
  return JSON.stringify([policy.typeCode, policy.classCode]);
}

/**
 * Orders filings newest first: effective date, then the date FMCSA received it.
 *
 * The received date is not a tie-break of convenience. USDOT 80806 carries two
 * BI&PD primary filings both effective 1993-03-01 — one received in 1992, one in
 * 2026 — and on effective date alone they are indistinguishable, so both would
 * read as the newest. ISO dates compare correctly as strings, so no Date is
 * constructed; a missing date sorts last.
 */
function byRecency(a: Filing, b: Filing): number {
  return (
    (b.effectiveDate ?? "").localeCompare(a.effectiveDate ?? "") ||
    (b.filedDate ?? "").localeCompare(a.filedDate ?? "")
  );
}

/**
 * Collapses the repeated rows, orders newest filing first, and flags the newest
 * within each coverage.
 */
export function normalizePolicies(rows: unknown[]): FmcsaInsurancePolicy[] {
  const deduped = new Map<string, Filing>();

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const policy = normalizePolicy(row);
    // First wins; the repeats are byte-identical, so which one is arbitrary.
    if (!deduped.has(policyKey(policy))) deduped.set(policyKey(policy), policy);
  }

  const policies = [...deduped.values()].sort(
    (a, b) =>
      byRecency(a, b) || (a.insuranceCompanyName ?? "").localeCompare(b.insuranceCompanyName ?? ""),
  );

  // Sorted newest first, so the first filing of each coverage is its newest. A
  // later one ties only by matching on both dates, and then the dataset gives no
  // ground to prefer either, so both are flagged.
  const newestPerCoverage = new Map<string, Filing>();

  for (const policy of policies) {
    const coverage = coverageKey(policy);
    if (!newestPerCoverage.has(coverage)) newestPerCoverage.set(coverage, policy);
  }

  return policies.map((policy) => ({
    ...policy,
    isLatestForCoverage: byRecency(policy, newestPerCoverage.get(coverageKey(policy))!) === 0,
  }));
}

// --- Lookup ----------------------------------------------------------------

/**
 * Fetches every insurance filing on record for one USDOT number.
 *
 * An empty list is a success, not a failure: plenty of USDOT numbers are
 * registered with no filing against them, and that is an answer the page should
 * state rather than an error it should report.
 */
export async function lookupInsurance(dotNumberInput: string): Promise<FmcsaInsuranceResult> {
  const dotNumber = normalizeDotNumber(dotNumberInput);

  if (!dotNumber) {
    return {
      ok: false,
      failure: "invalid-dot",
      message: "Enter a USDOT number — digits only, up to 8 of them.",
    };
  }

  const url = new URL(DATASET_URL);
  url.searchParams.set("usdot_number", dotNumber);
  url.searchParams.set("$limit", String(ROW_LIMIT));

  // Optional. Anonymous requests work but share a per-IP throttle with every
  // other anonymous caller, so a token is the difference between a POC that
  // responds and one that intermittently 429s.
  const appToken = process.env.SOCRATA_APP_TOKEN?.trim();

  let response: Response;

  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...(appToken ? { "X-App-Token": appToken } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return {
      ok: false,
      failure: "network",
      message: "Could not reach the FMCSA insurance dataset. Check the connection and try again.",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      failure: "upstream",
      message: `The FMCSA insurance dataset returned ${response.status}. Try again shortly.`,
    };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      failure: "upstream",
      message: "The FMCSA insurance dataset returned a response that was not JSON.",
    };
  }

  // Socrata reports a rejected query as a 200-adjacent JSON object rather than
  // the array of rows, so the shape is the check.
  if (!Array.isArray(body)) {
    return {
      ok: false,
      failure: "upstream",
      message: "The FMCSA insurance dataset returned an unexpected response.",
    };
  }

  const policies = normalizePolicies(body);

  // `raw` is the body untouched, duplicates and all. The deduping above is how
  // the table reads; the raw panel is there to check the table against, which
  // it cannot do if it has been through the same filter.
  return { ok: true, policies, raw: body, rowCount: body.length };
}
