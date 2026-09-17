import { afterEach, describe, expect, it, vi } from "vitest";

import {
  lookupInsurance,
  normalizePolicies,
  parseAmount,
  parseFiledDate,
} from "./insurance";

/**
 * The two things the published extract does that a naive read gets wrong: it
 * repeats every row, and it offers no cancellation date. These cover the first
 * directly, and pin the second down as "newest per coverage" so a later change
 * cannot quietly turn the badge into a claim that coverage is in force.
 *
 * The rows below are shapes observed from USDOT 80806 and 264184.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    void input;
    void init;
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const EXCESS = {
  docket_number: "MC135797",
  usdot_number: "80806",
  ins_form_code: "BMC-91X",
  ins_type_code: "1",
  ins_class_code: "E",
  max_cov_amount: "2500000.00",
  underl_lim_amount: "500000.00",
  policy_no: "XSAH11347472",
  effective_date: "20251231",
  insurance_company_name: "Ace American Insurance Company",
  trans_date: "20260421",
};

const PRIMARY = {
  docket_number: "MC135797",
  usdot_number: "80806",
  ins_form_code: "BMC-91X",
  ins_type_code: "1",
  ins_class_code: "P",
  max_cov_amount: "1000000.00",
  underl_lim_amount: "0.00",
  policy_no: "0",
  effective_date: "19930301",
  insurance_company_name: "Self-Insured",
  trans_date: "20260708",
};

/** Same coverage as PRIMARY, superseded by it. */
const OLDER_PRIMARY = { ...PRIMARY, effective_date: "19900101", policy_no: "OLD-1" };

describe("parseFiledDate", () => {
  it("reads the dataset's YYYYMMDD as an ISO date", () => {
    expect(parseFiledDate("20221031")).toBe("2022-10-31");
  });

  it("refuses anything that is not eight digits", () => {
    expect(parseFiledDate("2022-10-31")).toBeNull();
    expect(parseFiledDate("202210")).toBeNull();
    expect(parseFiledDate("")).toBeNull();
    expect(parseFiledDate(null)).toBeNull();
  });
});

describe("parseAmount", () => {
  it("drops the trailing zero cents every value carries", () => {
    expect(parseAmount("5000000.00")).toBe("5000000");
    expect(parseAmount("0.00")).toBe("0");
  });

  it("keeps cents that are not zero", () => {
    expect(parseAmount("1234.56")).toBe("1234.56");
  });

  it("returns null rather than coercing a non-number", () => {
    expect(parseAmount("n/a")).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
  });
});

describe("normalizePolicies", () => {
  it("collapses the extract's repeated rows", () => {
    const policies = normalizePolicies([EXCESS, EXCESS, EXCESS, EXCESS]);

    expect(policies).toHaveLength(1);
    expect(policies[0].policyNumber).toBe("XSAH11347472");
  });

  it("keeps rows that differ only in coverage amount", () => {
    // Observed on USDOT 264184: one policy, three limits, all real rows.
    const policies = normalizePolicies([
      EXCESS,
      { ...EXCESS, max_cov_amount: "75000.00" },
      { ...EXCESS, max_cov_amount: "1000000.00" },
    ]);

    expect(policies).toHaveLength(3);
  });

  it("labels the filed codes without discarding them", () => {
    const [policy] = normalizePolicies([EXCESS]);

    expect(policy.typeCode).toBe("1");
    expect(policy.typeLabel).toBe("BI&PD");
    expect(policy.classCode).toBe("E");
    expect(policy.classLabel).toBe("Excess");
    expect(policy.formCode).toBe("BMC-91X");
    expect(policy.formLabel).toBe("BI&PD, Primary/Excess");
  });

  it("leaves an undocumented code unlabelled instead of mislabelling it", () => {
    const [policy] = normalizePolicies([{ ...EXCESS, ins_type_code: "9", ins_class_code: "Z" }]);

    expect(policy.typeCode).toBe("9");
    expect(policy.typeLabel).toBeNull();
    expect(policy.classLabel).toBeNull();
  });

  it("orders newest filing first", () => {
    const policies = normalizePolicies([OLDER_PRIMARY, EXCESS, PRIMARY]);

    expect(policies.map((policy) => policy.effectiveDate)).toEqual([
      "2025-12-31",
      "1993-03-01",
      "1990-01-01",
    ]);
  });

  it("flags the newest filing of each coverage, so excess and primary both count", () => {
    const policies = normalizePolicies([OLDER_PRIMARY, EXCESS, PRIMARY]);

    const flagged = policies.filter((policy) => policy.isLatestForCoverage);

    expect(flagged).toHaveLength(2);
    expect(flagged.map((policy) => policy.classCode).sort()).toEqual(["E", "P"]);
    // The superseded primary is present but not flagged.
    expect(policies.find((policy) => policy.policyNumber === "OLD-1")?.isLatestForCoverage).toBe(
      false,
    );
  });

  it("breaks a tie on effective date by the date FMCSA received the filing", () => {
    // USDOT 80806: two BI&PD primary filings both effective 1993-03-01, one
    // received in 1992 and one in 2026. On effective date alone both read as
    // newest, which is how a filing superseded 34 years ago gets flagged.
    const superseded = {
      ...PRIMARY,
      policy_no: "NONE",
      insurance_company_name: "Palisades Insurance Company",
      trans_date: "19921002",
    };

    const policies = normalizePolicies([PRIMARY, superseded]);

    expect(policies.map((policy) => policy.policyNumber)).toEqual(["0", "NONE"]);
    expect(policies.map((policy) => policy.isLatestForCoverage)).toEqual([true, false]);
  });

  it("flags every filing of a coverage that shares both dates", () => {
    const tied = { ...PRIMARY, policy_no: "TIED-1", insurance_company_name: "Another Insurer" };
    const policies = normalizePolicies([PRIMARY, tied]);

    expect(policies.every((policy) => policy.isLatestForCoverage)).toBe(true);
  });

  it("ignores a row that is not an object", () => {
    expect(normalizePolicies([EXCESS, null, "nope", 7])).toHaveLength(1);
  });
});

describe("lookupInsurance", () => {
  it("rejects a malformed number without calling the dataset", async () => {
    const fetchMock = stubFetch(jsonResponse([]));

    const result = await lookupInsurance("MC-1515");

    expect(result).toMatchObject({ ok: false, failure: "invalid-dot" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters the dataset by usdot_number", async () => {
    const fetchMock = stubFetch(jsonResponse([EXCESS]));

    await lookupInsurance("0080806");

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe(
      "https://data.transportation.gov/resource/c5y8-a4uz.json",
    );
    expect(url.searchParams.get("usdot_number")).toBe("80806");
    expect(url.searchParams.get("$limit")).toBe("500");
  });

  it("sends an app token only when one is configured", async () => {
    const anonymous = stubFetch(jsonResponse([]));
    await lookupInsurance("80806");
    expect(anonymous.mock.calls[0][1]?.headers).not.toHaveProperty("X-App-Token");

    const withToken = stubFetch(jsonResponse([]));
    vi.stubEnv("SOCRATA_APP_TOKEN", "test-token");
    await lookupInsurance("80806");
    expect(withToken.mock.calls[0][1]?.headers).toMatchObject({ "X-App-Token": "test-token" });
  });

  it("reports how many rows arrived alongside the deduped ones", async () => {
    stubFetch(jsonResponse([EXCESS, EXCESS, PRIMARY]));

    const result = await lookupInsurance("80806");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowCount).toBe(3);
    expect(result.raw).toHaveLength(2);
    expect(result.policies).toHaveLength(2);
  });

  it("treats a carrier with no filings as a success, not a miss", async () => {
    stubFetch(jsonResponse([]));

    const result = await lookupInsurance("99999999");

    expect(result).toMatchObject({ ok: true, policies: [], rowCount: 0 });
  });

  it("treats Socrata's error object as an upstream failure", async () => {
    stubFetch(jsonResponse({ error: true, message: "Invalid SoQL query" }));

    expect(await lookupInsurance("80806")).toMatchObject({ ok: false, failure: "upstream" });
  });

  it("maps a non-2xx response to upstream", async () => {
    stubFetch(jsonResponse([], 429));

    expect(await lookupInsurance("80806")).toMatchObject({ ok: false, failure: "upstream" });
  });

  it("maps a transport failure to network", async () => {
    stubFetch(new TypeError("fetch failed"));

    expect(await lookupInsurance("80806")).toMatchObject({ ok: false, failure: "network" });
  });
});
