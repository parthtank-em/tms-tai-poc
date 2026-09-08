import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveConsentLocation, toAlpha3 } from "./consent";

/**
 * Jumio rejects the whole account call when the consent location is missing or
 * malformed, so these cover the exact rules it enforces: alpha-3 country,
 * always present, plus a state whenever the country is the USA.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

function headers(values: Record<string, string>) {
  return new Headers(values);
}

describe("toAlpha3", () => {
  it("converts alpha-2 to alpha-3", () => {
    expect(toAlpha3("US")).toBe("USA");
    expect(toAlpha3("IN")).toBe("IND");
    expect(toAlpha3("GB")).toBe("GBR");
  });

  it("passes an alpha-3 code through", () => {
    expect(toAlpha3("USA")).toBe("USA");
    expect(toAlpha3("deu")).toBe("DEU");
  });

  it("rejects anything that is not a country code", () => {
    expect(toAlpha3("United States")).toBeNull();
    expect(toAlpha3("")).toBeNull();
    expect(toAlpha3(null)).toBeNull();
  });

  it("returns null for an unmapped alpha-2 rather than guessing", () => {
    expect(toAlpha3("ZZ")).toBeNull();
  });
});

describe("resolveConsentLocation", () => {
  it("uses the platform geolocation headers", () => {
    const location = resolveConsentLocation(
      headers({ "x-vercel-ip-country": "US", "x-vercel-ip-country-region": "CA" }),
    );

    expect(location).toEqual({ country: "USA", state: "CA" });
  });

  it("drops the state outside the USA, where Jumio does not want it", () => {
    const location = resolveConsentLocation(
      headers({ "x-vercel-ip-country": "IN", "x-vercel-ip-country-region": "MH" }),
    );

    expect(location).toEqual({ country: "IND", state: null });
  });

  it("refuses a US location with no state, because Jumio requires one", () => {
    expect(resolveConsentLocation(headers({ "x-vercel-ip-country": "US" }))).toBeNull();
  });

  it("refuses when no country can be established", () => {
    expect(resolveConsentLocation(headers({}))).toBeNull();
  });

  it("lets explicit configuration override geolocation", () => {
    vi.stubEnv("JUMIO_CONSENT_COUNTRY", "USA");
    vi.stubEnv("JUMIO_CONSENT_STATE", "IL");

    const location = resolveConsentLocation(
      headers({ "x-vercel-ip-country": "IN", "x-vercel-ip-country-region": "MH" }),
    );

    // The operator testing from India on behalf of a US driver is the case that
    // makes this override necessary.
    expect(location).toEqual({ country: "USA", state: "IL" });
  });

  it("accepts a configured country with the state coming from geolocation", () => {
    vi.stubEnv("JUMIO_CONSENT_COUNTRY", "US");

    const location = resolveConsentLocation(headers({ "x-vercel-ip-country-region": "TX" }));

    expect(location).toEqual({ country: "USA", state: "TX" });
  });

  it("normalises lowercase configuration", () => {
    vi.stubEnv("JUMIO_CONSENT_COUNTRY", "usa");
    vi.stubEnv("JUMIO_CONSENT_STATE", "ca");

    expect(resolveConsentLocation(headers({}))).toEqual({ country: "USA", state: "CA" });
  });
});
