import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Radar webhook authentication.
 *
 * Radar sends `X-Radar-Signing-Id` and `X-Radar-Signature`, the latter being
 * an HMAC-SHA1 of the signing id keyed with the webhook's security token.
 *
 * Note what that does and does not prove: only someone holding the token
 * could have produced the signature, but the body is not part of it. A
 * captured request could be replayed with a different body under the same
 * headers. Acceptable over HTTPS for a POC; revisit for production.
 *
 * Radar's docs do not say whether the digest is hex or base64, so both are
 * accepted.
 *
 * @see https://docs.radar.com/integrations/webhooks
 */

export type WebhookAuthResult = "AUTHORIZED" | "MISSING_HEADERS" | "BAD_SIGNATURE";

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Compare against a same-length buffer and fold the result in.
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }

  return timingSafeEqual(left, right);
}

export function verifyRadarWebhook(headers: Headers, token: string): WebhookAuthResult {
  const signingId = headers.get("x-radar-signing-id");
  const signature = headers.get("x-radar-signature")?.trim();

  if (!signingId || !signature) return "MISSING_HEADERS";

  const digest = createHmac("sha1", token).update(signingId).digest();

  // Evaluate both so the time taken does not depend on which encoding matched.
  const hex = constantTimeEquals(signature.toLowerCase(), digest.toString("hex"));
  const base64 = constantTimeEquals(signature, digest.toString("base64"));

  return hex || base64 ? "AUTHORIZED" : "BAD_SIGNATURE";
}
