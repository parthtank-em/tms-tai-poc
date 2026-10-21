import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyRadarWebhook } from "./webhook-auth";

/**
 * The webhook moves trip state, so the interesting cases are the ways an
 * unauthenticated caller must fail.
 */

const TOKEN = "webhook-token";
const SIGNING_ID = "5f1e2d3c4b5a69788796a5b4";

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

const digest = createHmac("sha1", TOKEN).update(SIGNING_ID).digest();

describe("verifyRadarWebhook", () => {
  it("accepts a hex signature", () => {
    const result = verifyRadarWebhook(
      headers({ "X-Radar-Signing-Id": SIGNING_ID, "X-Radar-Signature": digest.toString("hex") }),
      TOKEN,
    );
    expect(result).toBe("AUTHORIZED");
  });

  it("accepts an upper-case hex signature", () => {
    const result = verifyRadarWebhook(
      headers({
        "X-Radar-Signing-Id": SIGNING_ID,
        "X-Radar-Signature": digest.toString("hex").toUpperCase(),
      }),
      TOKEN,
    );
    expect(result).toBe("AUTHORIZED");
  });

  it("accepts a base64 signature", () => {
    const result = verifyRadarWebhook(
      headers({ "X-Radar-Signing-Id": SIGNING_ID, "X-Radar-Signature": digest.toString("base64") }),
      TOKEN,
    );
    expect(result).toBe("AUTHORIZED");
  });

  it("rejects a signature made with another token", () => {
    const forged = createHmac("sha1", "guess").update(SIGNING_ID).digest("hex");
    const result = verifyRadarWebhook(
      headers({ "X-Radar-Signing-Id": SIGNING_ID, "X-Radar-Signature": forged }),
      TOKEN,
    );
    expect(result).toBe("BAD_SIGNATURE");
  });

  it("rejects a valid signature presented with a different signing id", () => {
    const result = verifyRadarWebhook(
      headers({ "X-Radar-Signing-Id": "another-id", "X-Radar-Signature": digest.toString("hex") }),
      TOKEN,
    );
    expect(result).toBe("BAD_SIGNATURE");
  });

  it("rejects a request missing either header", () => {
    expect(verifyRadarWebhook(headers({ "X-Radar-Signing-Id": SIGNING_ID }), TOKEN)).toBe(
      "MISSING_HEADERS",
    );
    expect(
      verifyRadarWebhook(headers({ "X-Radar-Signature": digest.toString("hex") }), TOKEN),
    ).toBe("MISSING_HEADERS");
  });
});
