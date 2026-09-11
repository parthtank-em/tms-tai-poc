import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetJumioAuthCacheForTests,
  getJumioAccessToken,
  invalidateJumioAccessToken,
  JumioAuthError,
} from "./auth";

import type { JumioConfig } from "./config";

/**
 * Token caching is the part of the OAuth flow that can go quietly wrong: a
 * missing cache burns the 10/s rate limit, and an over-eager one keeps using a
 * token that has expired. Both directions are covered here.
 */

const CONFIG: JumioConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  datacenter: "amer-1",
  authUrl: "https://auth.amer-1.jumio.ai/oauth2/token",
  accountBaseUrl: "https://account.amer-1.jumio.ai",
  retrievalBaseUrl: "https://retrieval.amer-1.jumio.ai",
  workflowKey: "10549",
  documentWorkflowKey: "10170",
  authWorkflowKey: "10014",
  callbackUrl: "https://example.test/api/jumio/callback?token=secret",
  callbackSecret: "secret",
  appUrl: "https://example.test",
  userAgent: "FreightID Test/1.0",
  tokenLifetime: null,
  acquisitionChannel: "sdk",
  sdkDatacenter: "us",
};

function tokenResponse(token: string, expiresIn = 3600) {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: "Bearer" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  __resetJumioAuthCacheForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("getJumioAccessToken", () => {
  it("requests a token with client_credentials and Basic auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse("token-1"));
    vi.stubGlobal("fetch", fetchMock);

    await getJumioAccessToken(CONFIG);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(url).toBe(CONFIG.authUrl);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("grant_type=client_credentials");
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
  });

  it("reuses a cached token instead of asking again", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse("token-1"));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getJumioAccessToken(CONFIG)).toBe("token-1");
    expect(await getJumioAccessToken(CONFIG)).toBe("token-1");
    expect(await getJumioAccessToken(CONFIG)).toBe("token-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes early, before the token actually expires", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("token-1", 3600))
      .mockResolvedValueOnce(tokenResponse("token-2", 3600));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getJumioAccessToken(CONFIG)).toBe("token-1");

    // Inside the two-minute safety margin but not yet expired: still refreshed,
    // so a call cannot go out holding a token that dies in flight.
    vi.setSystemTime(Date.now() + (3600 - 60) * 1000);

    expect(await getJumioAccessToken(CONFIG)).toBe("token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent callers into a single token request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse("token-1"));
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await Promise.all([
      getJumioAccessToken(CONFIG),
      getJumioAccessToken(CONFIG),
      getJumioAccessToken(CONFIG),
    ]);

    expect(tokens).toEqual(["token-1", "token-1", "token-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches again after the cache is invalidated by a 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("token-1"))
      .mockResolvedValueOnce(tokenResponse("token-2"));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getJumioAccessToken(CONFIG)).toBe("token-1");
    invalidateJumioAccessToken();
    expect(await getJumioAccessToken(CONFIG)).toBe("token-2");
  });

  it("raises a sanitized error on a rejected token request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 403 })));

    await expect(getJumioAccessToken(CONFIG)).rejects.toBeInstanceOf(JumioAuthError);
  });

  it("never puts the client secret in the error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));

    await expect(getJumioAccessToken(CONFIG)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("client-secret") as unknown as string,
      }),
    );
  });

  it("raises rather than caching a response with no access_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(getJumioAccessToken(CONFIG)).rejects.toBeInstanceOf(JumioAuthError);
  });

  it("does not cache a failure — the next call tries again", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(tokenResponse("token-1"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getJumioAccessToken(CONFIG)).rejects.toBeInstanceOf(JumioAuthError);
    expect(await getJumioAccessToken(CONFIG)).toBe("token-1");
  });
});
