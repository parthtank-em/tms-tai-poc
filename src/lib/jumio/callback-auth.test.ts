import { afterEach, describe, expect, it, vi } from "vitest";

import { isKnownJumioIp, verifyJumioCallback } from "./callback-auth";

import type { JumioConfig } from "./config";

/**
 * The callback endpoint can move a driver to VERIFIED, so the interesting cases
 * are all the ways an unauthenticated caller must *fail* to do that.
 */

const CONFIG: JumioConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  datacenter: "amer-1",
  authUrl: "https://auth.amer-1.jumio.ai/oauth2/token",
  accountBaseUrl: "https://account.amer-1.jumio.ai",
  retrievalBaseUrl: "https://retrieval.amer-1.jumio.ai",
  workflowKey: "10549",
  callbackUrl: "https://example.test/api/jumio/callback?token=the-secret",
  callbackSecret: "the-secret",
  appUrl: "https://example.test",
  userAgent: "FreightID Test/1.0",
  tokenLifetime: null,
};

const JUMIO_US_IP = "34.202.241.227";

function callback(token: string | null, ip = JUMIO_US_IP) {
  const url = new URL("https://example.test/api/jumio/callback");
  if (token !== null) url.searchParams.set("token", token);

  return { url, headers: new Headers(ip ? { "x-forwarded-for": ip } : {}) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("verifyJumioCallback", () => {
  it("accepts a delivery carrying the configured secret", () => {
    const { url, headers } = callback("the-secret");

    expect(verifyJumioCallback(url, headers, CONFIG).result).toBe("AUTHORIZED");
  });

  it("rejects a wrong secret", () => {
    const { url, headers } = callback("not-the-secret");

    expect(verifyJumioCallback(url, headers, CONFIG).result).toBe("BAD_SECRET");
  });

  it("rejects a missing secret", () => {
    const { url, headers } = callback(null);

    expect(verifyJumioCallback(url, headers, CONFIG).result).toBe("BAD_SECRET");
  });

  it("rejects a secret that is merely a prefix of the real one", () => {
    const { url, headers } = callback("the-sec");

    expect(verifyJumioCallback(url, headers, CONFIG).result).toBe("BAD_SECRET");
  });

  it("accepts an unrecognised source IP by default, and says so", () => {
    // The default, because behind a tunnel the observed IP is the tunnel's.
    const { url, headers } = callback("the-secret", "203.0.113.9");
    const outcome = verifyJumioCallback(url, headers, CONFIG);

    expect(outcome.result).toBe("AUTHORIZED");
    expect(outcome.knownIp).toBe(false);
  });

  it("rejects an unrecognised source IP once enforcement is on", () => {
    vi.stubEnv("JUMIO_CALLBACK_ENFORCE_IP", "true");

    const { url, headers } = callback("the-secret", "203.0.113.9");

    expect(verifyJumioCallback(url, headers, CONFIG).result).toBe("BAD_SOURCE_IP");
  });

  it("still accepts a published Jumio IP with enforcement on", () => {
    vi.stubEnv("JUMIO_CALLBACK_ENFORCE_IP", "true");

    const { url, headers } = callback("the-secret", JUMIO_US_IP);

    expect(verifyJumioCallback(url, headers, CONFIG).result).toBe("AUTHORIZED");
  });

  it("checks the secret before the source IP, so a stranger learns nothing from the IP check", () => {
    vi.stubEnv("JUMIO_CALLBACK_ENFORCE_IP", "true");

    const { url, headers } = callback("wrong", "203.0.113.9");

    expect(verifyJumioCallback(url, headers, CONFIG).result).toBe("BAD_SECRET");
  });

  it("reports the client IP from x-forwarded-for", () => {
    const url = new URL("https://example.test/api/jumio/callback?token=the-secret");
    const headers = new Headers({ "x-forwarded-for": `${JUMIO_US_IP}, 10.0.0.1` });

    expect(verifyJumioCallback(url, headers, CONFIG).remoteIp).toBe(JUMIO_US_IP);
  });
});

describe("isKnownJumioIp", () => {
  it("recognises published addresses per datacenter", () => {
    expect(isKnownJumioIp("34.202.241.227", "amer-1")).toBe(true);
    expect(isKnownJumioIp("52.209.180.134", "emea-1")).toBe(true);
    expect(isKnownJumioIp("3.0.109.121", "apac-1")).toBe(true);
  });

  it("does not accept another region's address", () => {
    expect(isKnownJumioIp("52.209.180.134", "amer-1")).toBe(false);
  });

  it("does not accept an unknown or missing address", () => {
    expect(isKnownJumioIp("203.0.113.9", "amer-1")).toBe(false);
    expect(isKnownJumioIp(null, "amer-1")).toBe(false);
  });
});
