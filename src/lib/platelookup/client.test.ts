import { afterEach, describe, expect, it, vi } from "vitest";

import { buildQuery, lookupVehicle, normalizeVehicle } from "./client";

/**
 * `/v3/history` identifies a vehicle by VIN or by state + plate, and each call
 * is metered. These cover both halves of that: which inputs are allowed to
 * reach the API at all, and that each documented failure is reported as itself
 * rather than collapsing into one generic error.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** The VIN from the Swagger example in docs/platelookup - API.pdf. */
const SAMPLE_VIN = "3GNCJLSBXLL230525";

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

function query(overrides: Partial<{ vin: string; state: string; plate: string }> = {}) {
  return { vin: "", state: "", plate: "", ...overrides };
}

describe("buildQuery", () => {
  it("accepts a VIN on its own", () => {
    const built = buildQuery(query({ vin: SAMPLE_VIN }));

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.params.get("vin")).toBe(SAMPLE_VIN);
    expect(built.params.has("plate")).toBe(false);
  });

  it("accepts a state and plate on their own, upper-cased", () => {
    const built = buildQuery(query({ state: "va", plate: "9247dg" }));

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.params.get("state")).toBe("VA");
    expect(built.params.get("plate")).toBe("9247DG");
  });

  it("rejects a plate with no state, which the docs mark as required", () => {
    expect(buildQuery(query({ plate: "9247DG" }))).toMatchObject({ ok: false });
  });

  it("rejects a state with no plate", () => {
    expect(buildQuery(query({ state: "VA" }))).toMatchObject({ ok: false });
  });

  it("rejects a state that is not a 2-letter code", () => {
    expect(buildQuery(query({ state: "Virginia", plate: "9247DG" }))).toMatchObject({ ok: false });
  });

  it("rejects a VIN of the wrong length or with an excluded letter", () => {
    expect(buildQuery(query({ vin: "3GNCJLSBXLL23052" }))).toMatchObject({ ok: false });
    expect(buildQuery(query({ vin: "3GNCJLSBXLL23052I" }))).toMatchObject({ ok: false });
  });

  it("rejects an empty form rather than spending a call", () => {
    expect(buildQuery(query())).toMatchObject({ ok: false });
  });
});

describe("normalizeVehicle", () => {
  it("flattens the documented vehicle block", () => {
    const vehicle = normalizeVehicle({
      VIN: SAMPLE_VIN,
      vehicle: {
        make: "CHEVROLET",
        model: "Trax",
        year: 2020,
        trim: "1LT",
        engine: "1.4L L4 DOHC 16V",
        drivetrain: "Fwd Front Wheel Drive",
        fuel_type: "Gasoline",
        base_msrp: "$23,200",
        body_type: "Sport Utility Vehicle (SUV)",
        manufactured_in: "Mexico",
      },
    });

    expect(vehicle.vin).toBe(SAMPLE_VIN);
    expect(vehicle.make).toBe("CHEVROLET");
    expect(vehicle.year).toBe("2020");
    expect(vehicle.bodyType).toBe("Sport Utility Vehicle (SUV)");
    expect(vehicle.manufacturedIn).toBe("Mexico");
  });

  it('treats the API\'s "-" placeholder as no value', () => {
    expect(normalizeVehicle({ vehicle: { trim: "-" } }).trim).toBeNull();
  });

  it("survives a payload with no vehicle block", () => {
    expect(normalizeVehicle({ VIN: SAMPLE_VIN }).make).toBeNull();
  });
});

describe("lookupVehicle", () => {
  it("refuses an unidentifiable vehicle without calling the API", async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    vi.stubEnv("PLATELOOKUP_API_KEY", "test-key");

    const result = await lookupVehicle(query());

    expect(result).toMatchObject({ ok: false, failure: "invalid-query" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a missing key instead of calling the API without one", async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    vi.stubEnv("PLATELOOKUP_API_KEY", "");

    const result = await lookupVehicle(query({ vin: SAMPLE_VIN }));

    expect(result).toMatchObject({ ok: false, failure: "unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the key as a header, not a query parameter", async () => {
    const fetchMock = stubFetch(jsonResponse({ success: true, data: { VIN: SAMPLE_VIN } }));
    vi.stubEnv("PLATELOOKUP_API_KEY", "test-key");

    await lookupVehicle(query({ state: "VA", plate: "9247DG" }));

    const [input, init] = fetchMock.mock.calls[0];
    const url = new URL(String(input));

    expect(url.origin + url.pathname).toBe("https://api.platelookup.app/v3/history");
    expect(url.searchParams.get("state")).toBe("VA");
    expect(url.searchParams.get("plate")).toBe("9247DG");
    expect(url.search).not.toContain("test-key");
    expect((init?.headers as Record<string, string>)["X-API-Key"]).toBe("test-key");
  });

  it("unwraps the success/data envelope", async () => {
    stubFetch(
      jsonResponse({
        success: true,
        data: { VIN: SAMPLE_VIN, vehicle: { make: "CHEVROLET" }, recalls: [{}] },
      }),
    );
    vi.stubEnv("PLATELOOKUP_API_KEY", "test-key");

    const result = await lookupVehicle(query({ vin: SAMPLE_VIN }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vehicle.make).toBe("CHEVROLET");
    // The history sections are not mapped, but they must survive into the raw
    // view — that is the only place they reach the page.
    expect(result.raw).toMatchObject({ recalls: [{}] });
  });

  it("accepts the unwrapped payload the schema example shows", async () => {
    stubFetch(jsonResponse({ VIN: SAMPLE_VIN, vehicle: { make: "Ford" } }));
    vi.stubEnv("PLATELOOKUP_API_KEY", "test-key");

    const result = await lookupVehicle(query({ vin: SAMPLE_VIN }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vehicle.make).toBe("Ford");
  });

  it("surfaces the API's own message on a 400", async () => {
    stubFetch(
      jsonResponse(
        { message: "Missing or invalid query parameters", error: "Bad Request", statusCode: 400 },
        400,
      ),
    );
    vi.stubEnv("PLATELOOKUP_API_KEY", "test-key");

    expect(await lookupVehicle(query({ vin: SAMPLE_VIN }))).toMatchObject({
      ok: false,
      failure: "bad-request",
      message: "Missing or invalid query parameters",
    });
  });

  it("maps the remaining status codes", async () => {
    vi.stubEnv("PLATELOOKUP_API_KEY", "test-key");

    stubFetch(jsonResponse({ message: "Missing or invalid `x-api-key` header." }, 401));
    expect(await lookupVehicle(query({ vin: SAMPLE_VIN }))).toMatchObject({
      ok: false,
      failure: "unauthorized",
    });

    stubFetch(jsonResponse({}, 404));
    expect(await lookupVehicle(query({ vin: SAMPLE_VIN }))).toMatchObject({
      ok: false,
      failure: "not-found",
    });

    stubFetch(jsonResponse({}, 503));
    expect(await lookupVehicle(query({ vin: SAMPLE_VIN }))).toMatchObject({
      ok: false,
      failure: "upstream",
    });
  });

  it("treats a 200 carrying no vehicle as not found", async () => {
    stubFetch(jsonResponse({ success: true }));
    vi.stubEnv("PLATELOOKUP_API_KEY", "test-key");

    expect(await lookupVehicle(query({ vin: SAMPLE_VIN }))).toMatchObject({
      ok: false,
      failure: "not-found",
    });
  });

  it("reports a transport failure without leaking the key", async () => {
    stubFetch(new TypeError("fetch failed for key test-key"));
    vi.stubEnv("PLATELOOKUP_API_KEY", "test-key");

    const result = await lookupVehicle(query({ vin: SAMPLE_VIN }));

    expect(result).toMatchObject({ ok: false, failure: "network" });
    if (result.ok) return;
    expect(result.message).not.toContain("test-key");
  });
});
