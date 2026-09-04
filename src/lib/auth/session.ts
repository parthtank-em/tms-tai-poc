import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal stateless session for the admin UI.
 *
 * There is no user table and no sign-up — the single operator credential lives
 * in the environment (see `credentials.ts`). A successful login mints a signed,
 * HttpOnly cookie; nothing is stored server-side, so restarts and multiple
 * instances need no shared state.
 *
 * The cookie is signed, **not encrypted**: its contents are readable by anyone
 * holding it, so it carries only a username and expiry, never the password.
 */

const COOKIE_NAME = "freightid_session";
const MAX_AGE_SECONDS = 60 * 60 * 8;

export type Session = { username: string; expiresAt: number };

function signingKey(): string {
  const secret = process.env.AUTH_SESSION_SECRET;

  if (!secret) {
    // Fail closed. Without a key every cookie would be forgeable, so refusing
    // to mint or accept one is the only safe behaviour.
    throw new Error(
      "AUTH_SESSION_SECRET is not set. Generate one with " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"` " +
        "and add it to .env.",
    );
  }

  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }

  return timingSafeEqual(left, right);
}

export function createSessionToken(username: string): { token: string; maxAge: number } {
  const session: Session = {
    username,
    expiresAt: Date.now() + MAX_AGE_SECONDS * 1000,
  };

  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");

  return { token: `${payload}.${sign(payload)}`, maxAge: MAX_AGE_SECONDS };
}

/** Returns null for anything tampered with, malformed, or expired. */
export function readSessionToken(token: string | undefined): Session | null {
  if (!token) return null;

  const separator = token.lastIndexOf(".");
  if (separator === -1) return null;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  if (!safeEquals(signature, sign(payload))) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;

    if (typeof session?.username !== "string" || typeof session?.expiresAt !== "number") {
      return null;
    }

    return session.expiresAt > Date.now() ? session : null;
  } catch {
    return null;
  }
}

export const sessionCookie = {
  name: COOKIE_NAME,
  /** Options shared by every place that writes the cookie. */
  options(maxAge: number) {
    return {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge,
    };
  },
};
