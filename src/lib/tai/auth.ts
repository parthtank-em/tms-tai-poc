import { timingSafeEqual } from "node:crypto";

import type { WebhookAuthResult } from "@/generated/prisma/enums";

/**
 * Inbound webhook authentication (findings §3).
 *
 * TAI does not sign payloads — there is no HMAC, no `X-Webhook-*` header, not
 * even a `User-Agent`. The `Authorization` header is the entire security
 * boundary, so it is treated as a long shared secret and compared in constant
 * time.
 *
 * Two schemes can be configured on TAI's side, and **Basic wins when both are
 * set**, so the same precedence is applied here.
 */
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

export function verifyWebhookAuth(authorizationHeader: string | null): WebhookAuthResult {
  const basicUser = process.env.TAI_WEBHOOK_BASIC_USER;
  const basicPassword = process.env.TAI_WEBHOOK_BASIC_PASSWORD;
  const staticToken = process.env.TAI_WEBHOOK_AUTH_TOKEN;

  const basicConfigured = Boolean(basicUser && basicPassword);
  const staticConfigured = Boolean(staticToken);

  if (!basicConfigured && !staticConfigured) {
    // Fail closed. Every delivery is rejected until a credential is set, which
    // is the safe default — but it is also a silent-404-shaped mistake, so say
    // so loudly in the log.
    console.error(
      "[tai-webhook] No inbound credential configured. Set TAI_WEBHOOK_AUTH_TOKEN, " +
        "or TAI_WEBHOOK_BASIC_USER + TAI_WEBHOOK_BASIC_PASSWORD. Rejecting delivery.",
    );
    return "UNAUTHORIZED";
  }

  if (!authorizationHeader) {
    return "UNAUTHORIZED";
  }

  if (basicConfigured) {
    const separatorIndex = authorizationHeader.indexOf(" ");
    if (separatorIndex === -1) {
      return "MALFORMED";
    }

    const scheme = authorizationHeader.slice(0, separatorIndex);
    const encoded = authorizationHeader.slice(separatorIndex + 1).trim();
    if (scheme.toLowerCase() !== "basic" || encoded.length === 0) {
      return "MALFORMED";
    }

    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const colonIndex = decoded.indexOf(":");
    if (colonIndex === -1) {
      return "MALFORMED";
    }

    const user = decoded.slice(0, colonIndex);
    const password = decoded.slice(colonIndex + 1);

    // Both halves are always compared so the timing does not reveal which one
    // was wrong.
    const userMatches = constantTimeEquals(user, basicUser!);
    const passwordMatches = constantTimeEquals(password, basicPassword!);

    return userMatches && passwordMatches ? "AUTHORIZED" : "UNAUTHORIZED";
  }

  // Static scheme: TAI sends the configured string verbatim, whatever it is
  // (`Bearer <token>`, `ApiKey <key>`, or a bare secret). No parsing.
  return constantTimeEquals(authorizationHeader, staticToken!) ? "AUTHORIZED" : "UNAUTHORIZED";
}

/** Request headers worth keeping, with the credential stripped (§3). */
export function scrubHeaders(headers: Headers): Record<string, string> {
  const redacted = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);
  const result: Record<string, string> = {};

  for (const [key, value] of headers) {
    if (!redacted.has(key.toLowerCase())) {
      result[key] = value;
    }
  }

  return result;
}

/** Best-effort client IP, for the inbound log only. */
export function clientIp(headers: Headers): string | null {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  return headers.get("x-real-ip");
}
