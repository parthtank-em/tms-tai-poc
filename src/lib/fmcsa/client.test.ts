import { afterEach, describe, expect, it, vi } from "vitest";

import { lookupCarrier, normalizeCarrier, normalizeDotNumber } from "./client";

/**
 * The docs are explicit that FMCSA omits any element with no value, and that a
 * lookup can fail six different ways. These cover both: that an absent element
 * reads as null rather than throwing, and that each failure is reported as
 * itself instead of collapsing into one generic error.
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
  const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
    void input;
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("normalizeDotNumber", () => {
  it("accepts a plain number", () => {
    expect(normalizeDotNumber("44110")).toBe("44110");
  });

  it("trims surrounding whitespace and leading zeros", () => {
    expect(normalizeDotNumber("  0044110 ")).toBe("44110");
  });

  it("rejects anything that is not digits", () => {
    expect(normalizeDotNumber("MC-1515")).toBeNull();
    expect(normalizeDotNumber("44110x")).toBeNull();
    expect(normalizeDotNumber("")).toBeNull();
    expect(normalizeDotNumber("   ")).toBeNull();
  });

  it("rejects a number longer than a USDOT number can be", () => {
    expect(normalizeDotNumber("123456789")).toBeNull();
  });
});

describe("normalizeCarrier", () => {
  it("maps the documented elements", () => {
    const carrier = normalizeCarrier({
      dotNumber: 44110,
      legalName: "GREYHOUND LINES INC",
      dbaName: "GREYHOUND",
      allowToOperate: "Y",
      complaintCount: 3,
      phyCity: "DALLAS",
      phyState: "TX",
      telephone: "2148495000",
    });

    expect(carrier.dotNumber).toBe(44110);
    expect(carrier.legalName).toBe("GREYHOUND LINES INC");
    expect(carrier.dbaName).toBe("GREYHOUND");
    expect(carrier.allowToOperate).toBe("Y");
    expect(carrier.complaintCount).toBe(3);
    expect(carrier.phyCity).toBe("DALLAS");
    expect(carrier.telephone).toBe("2148495000");
  });

  it("leaves omitted elements null rather than inventing a zero", () => {
    const carrier = normalizeCarrier({ dotNumber: 44110 });

    expect(carrier.complaintCount).toBeNull();
    expect(carrier.busVehicle).toBeNull();
    expect(carrier.legalName).toBeNull();
    expect(carrier.outOfServiceDate).toBeNull();
  });

  it("accepts either spelling where the docs and live responses differ", () => {
    expect(normalizeCarrier({ allowedToOperate: "N" }).allowToOperate).toBe("N");
    expect(normalizeCarrier({ phyZipcode: "75201" }).phyZip).toBe("75201");
  });

  it("coerces numbers sent as strings", () => {
    expect(normalizeCarrier({ dotNumber: "44110" }).dotNumber).toBe(44110);
    expect(normalizeCarrier({ complaintCount: "0" }).complaintCount).toBe(0);
  });
});

describe("lookupCarrier", () => {
  it("rejects a malformed number without calling FMCSA", async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    vi.stubEnv("FMCSA_WEB_KEY", "test-key");

    const result = await lookupCarrier("not-a-number");

    expect(result).toMatchObject({ ok: false, failure: "invalid-dot" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a missing webKey instead of calling FMCSA without one", async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    vi.stubEnv("FMCSA_WEB_KEY", "");

    const result = await lookupCarrier("44110");

    expect(result).toMatchObject({ ok: false, failure: "unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the webKey as a query parameter on the documented path", async () => {
    const fetchMock = stubFetch(
      jsonResponse({ content: { carrier: { dotNumber: 44110 } }, retrievalDate: "2026-09-14" }),
    );
    vi.stubEnv("FMCSA_WEB_KEY", "test-key");

    await lookupCarrier("44110");

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://mobile.fmcsa.dot.gov/qc/services/carriers/44110");
    expect(url.searchParams.get("webKey")).toBe("test-key");
  });

  it("unwraps the content.carrier envelope", async () => {
    stubFetch(
      jsonResponse({
        content: { carrier: { dotNumber: 44110, legalName: "GREYHOUND LINES INC" } },
        retrievalDate: "2026-09-14",
      }),
    );
    vi.stubEnv("FMCSA_WEB_KEY", "test-key");

    const result = await lookupCarrier("44110");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.carrier.legalName).toBe("GREYHOUND LINES INC");
    expect(result.retrievalDate).toBe("2026-09-14");
  });

  it("treats a 200 with empty content as not found", async () => {
    stubFetch(jsonResponse({ content: null, retrievalDate: "2026-09-14" }));
    vi.stubEnv("FMCSA_WEB_KEY", "test-key");

    expect(await lookupCarrier("99999999")).toMatchObject({ ok: false, failure: "not-found" });
  });

  it("maps the documented error codes", async () => {
    vi.stubEnv("FMCSA_WEB_KEY", "test-key");

    stubFetch(jsonResponse({}, 401));
    expect(await lookupCarrier("44110")).toMatchObject({ ok: false, failure: "unauthorized" });

    stubFetch(jsonResponse({}, 404));
    expect(await lookupCarrier("44110")).toMatchObject({ ok: false, failure: "not-found" });

    stubFetch(jsonResponse({}, 500));
    expect(await lookupCarrier("44110")).toMatchObject({ ok: false, failure: "upstream" });
  });

  it("reports a transport failure without leaking the URL that carries the key", async () => {
    stubFetch(new TypeError("fetch failed: https://mobile.fmcsa.dot.gov/...?webKey=test-key"));
    vi.stubEnv("FMCSA_WEB_KEY", "test-key");

    const result = await lookupCarrier("44110");

    expect(result).toMatchObject({ ok: false, failure: "network" });
    if (result.ok) return;
    expect(result.message).not.toContain("test-key");
  });
});
