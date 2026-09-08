import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetJumioAuthCacheForTests } from "./auth";
import { JumioApiError, JumioClient } from "./client";

import type { JumioConfig } from "./config";

/**
 * The client's job is to be boring: bearer token on, sensible error out. These
 * tests pin the two behaviours that are easy to get wrong — the single 401
 * retry, and never leaking a response body into an error message.
 */

const CONFIG: JumioConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  datacenter: "amer-1",
  authUrl: "https://auth.amer-1.jumio.ai/oauth2/token",
  accountBaseUrl: "https://account.amer-1.jumio.ai",
  retrievalBaseUrl: "https://retrieval.amer-1.jumio.ai",
  workflowKey: "10549",
  callbackUrl: "https://example.test/api/jumio/callback?token=secret",
  callbackSecret: "secret",
  appUrl: "https://example.test",
  userAgent: "FreightID Test/1.0",
  tokenLifetime: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TOKEN = () => json({ access_token: "token-1", expires_in: 3600, token_type: "Bearer" });

beforeEach(() => {
  __resetJumioAuthCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAccount", () => {
  it("posts to the documented path with a bearer token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN())
      .mockResolvedValueOnce(json({ account: { id: "acc-1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await new JumioClient(CONFIG).createAccount({
      customerInternalReference: "ver-1",
      workflowDefinition: { key: "10549" },
    });

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(url).toBe("https://account.amer-1.jumio.ai/api/v1/accounts");
    expect(init.method).toBe("POST");
    expect(headers.Authorization).toBe("Bearer token-1");
    expect(headers["User-Agent"]).toBe("FreightID Test/1.0");
  });
});

describe("retrieveWorkflow", () => {
  it("builds the documented retrieval path", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(TOKEN()).mockResolvedValueOnce(json({ workflow: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await new JumioClient(CONFIG).retrieveWorkflow("acc-1", "wf-1");

    const [url] = fetchMock.mock.calls[1] as [string];

    expect(url).toBe(
      "https://retrieval.amer-1.jumio.ai/api/v1/accounts/acc-1/workflow-executions/wf-1",
    );
  });
});

describe("error handling", () => {
  it("retries once on 401 with a fresh token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN())
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(TOKEN())
      .mockResolvedValueOnce(json({ workflow: { id: "wf-1" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new JumioClient(CONFIG).retrieveWorkflow("acc-1", "wf-1");

    expect(result.workflow?.id).toBe("wf-1");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("gives up after a second 401 rather than looping", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN())
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(TOKEN())
      .mockResolvedValueOnce(new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new JumioClient(CONFIG).retrieveWorkflow("acc-1", "wf-1")).rejects.toBeInstanceOf(
      JumioApiError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("marks 429 and 5xx retryable, and 4xx not", async () => {
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [400, false],
    ] as const) {
      __resetJumioAuthCacheForTests();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(TOKEN()).mockResolvedValueOnce(new Response("", { status })),
      );

      await expect(new JumioClient(CONFIG).retrieveWorkflow("acc-1", "wf-1")).rejects.toMatchObject({
        status,
        retryable,
      });
    }
  });

  it("never puts the response body in the error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(TOKEN())
        .mockResolvedValueOnce(new Response("secret diagnostic detail", { status: 400 })),
    );

    await expect(new JumioClient(CONFIG).retrieveWorkflow("acc-1", "wf-1")).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("secret diagnostic") as unknown as string,
      }),
    );
  });

  it("keeps Jumio's explanation in details, where only the log can see it", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(TOKEN())
        .mockResolvedValueOnce(new Response('{"message":"workflowDefinition.key invalid"}', { status: 400 })),
    );

    await expect(new JumioClient(CONFIG).retrieveWorkflow("acc-1", "wf-1")).rejects.toMatchObject({
      message: "Jumio returned HTTP 400.",
      details: expect.stringContaining("workflowDefinition.key invalid") as unknown as string,
    });
  });

  it("redacts our own secrets out of an echoed request body", async () => {
    // A distinctive value, so the assertion cannot be satisfied by accident by
    // the word "secret" inside the replacement marker itself.
    const config = { ...CONFIG, callbackSecret: "Zq7-callback-token-Zq7" };

    const echoed = JSON.stringify({
      message: "validation failed",
      request: { callbackUrl: `https://example.test/cb?token=${config.callbackSecret}` },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(TOKEN()).mockResolvedValueOnce(new Response(echoed, { status: 400 })),
    );

    const error = await new JumioClient(config)
      .retrieveWorkflow("acc-1", "wf-1")
      .catch((caught: JumioApiError) => caught);

    expect(error).toBeInstanceOf(JumioApiError);
    expect((error as JumioApiError).details).not.toContain(config.callbackSecret);
    expect((error as JumioApiError).details).toContain("[redacted-callback-secret]");
  });

  it("reports a network failure as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(TOKEN()).mockRejectedValueOnce(new Error("ECONNRESET")),
    );

    await expect(new JumioClient(CONFIG).retrieveWorkflow("acc-1", "wf-1")).rejects.toMatchObject({
      retryable: true,
      status: null,
    });
  });
});
