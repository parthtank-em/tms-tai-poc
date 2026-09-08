import { timingSafeEqual } from "node:crypto";

import type { JumioConfig, JumioDatacenter } from "./config";

/**
 * Callback authentication (§11, §20).
 *
 * Jumio does not sign callbacks. There is no HMAC and no shared signature
 * header, so the documented mechanism is a combination of two weaker checks:
 *
 * 1. **A secret in the callback URL.** We generate it, we hand it to Jumio in
 *    `callbackUrl`, and it comes back as a query parameter. This is the real
 *    gate, compared in constant time.
 * 2. **The documented source IPs.** Useful defence in depth, but only when the
 *    request reaches us directly — behind an ngrok/Cloudflare tunnel, or any
 *    proxy that does not preserve the client address, the observed IP is the
 *    tunnel's. So it is advisory by default and enforced only when
 *    `JUMIO_CALLBACK_ENFORCE_IP=true`, which is right for a real deployment and
 *    wrong for a laptop.
 *
 * The endpoint changes a driver's verification state, so it fails closed:
 * without a configured secret nothing is accepted.
 *
 * @see https://documentation.jumio.ai/docs/developer-resources/callback
 */

/** Jumio's published callback source addresses, per datacenter. */
const CALLBACK_IPS: Record<JumioDatacenter, readonly string[]> = {
  "amer-1": [
    "34.202.241.227",
    "34.226.103.119",
    "34.226.254.127",
    "52.8.136.236",
    "54.177.61.57",
    "54.183.15.212",
  ],
  "emea-1": [
    "34.253.41.236",
    "35.157.27.193",
    "52.48.0.25",
    "52.57.194.92",
    "52.58.113.86",
    "52.209.180.134",
  ],
  "apac-1": [
    "3.0.109.121",
    "52.76.184.73",
    "52.77.102.92",
    "13.238.100.17",
    "13.238.203.238",
    "52.64.132.26",
  ],
};

export type CallbackAuthResult = "AUTHORIZED" | "BAD_SECRET" | "BAD_SOURCE_IP";

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

/** Best-effort client IP. Only meaningful when nothing untrusted sits in front. */
export function callbackClientIp(headers: Headers): string | null {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  return headers.get("x-real-ip");
}

export function isKnownJumioIp(ip: string | null, datacenter: JumioDatacenter): boolean {
  return ip !== null && CALLBACK_IPS[datacenter].includes(ip);
}

export function verifyJumioCallback(
  url: URL,
  headers: Headers,
  config: JumioConfig,
): { result: CallbackAuthResult; remoteIp: string | null; knownIp: boolean } {
  const remoteIp = callbackClientIp(headers);
  const knownIp = isKnownJumioIp(remoteIp, config.datacenter);

  const presented = url.searchParams.get("token");

  if (!presented || !constantTimeEquals(presented, config.callbackSecret)) {
    return { result: "BAD_SECRET", remoteIp, knownIp };
  }

  const enforceIp = process.env.JUMIO_CALLBACK_ENFORCE_IP?.trim().toLowerCase() === "true";

  if (enforceIp && !knownIp) {
    return { result: "BAD_SOURCE_IP", remoteIp, knownIp };
  }

  return { result: "AUTHORIZED", remoteIp, knownIp };
}
