import { timingSafeEqual } from "node:crypto";

/**
 * The single operator credential for the admin UI.
 *
 * Deliberately the same pair TAI uses for inbound webhook Basic auth
 * (`TAI_WEBHOOK_BASIC_USER` / `TAI_WEBHOOK_BASIC_PASSWORD`) — see
 * docs/TECH_STACK.md for why that is a POC-only shortcut worth undoing before
 * this is exposed to anyone outside the team.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }

  return timingSafeEqual(left, right);
}

export function verifyCredentials(username: string, password: string): boolean {
  const expectedUser = process.env.TAI_WEBHOOK_BASIC_USER;
  const expectedPassword = process.env.TAI_WEBHOOK_BASIC_PASSWORD;

  if (!expectedUser || !expectedPassword) {
    console.error(
      "[auth] TAI_WEBHOOK_BASIC_USER / TAI_WEBHOOK_BASIC_PASSWORD are not set. " +
        "Nobody can sign in until they are.",
    );
    return false;
  }

  // Both halves are always compared so timing does not reveal which was wrong.
  const userMatches = constantTimeEquals(username, expectedUser);
  const passwordMatches = constantTimeEquals(password, expectedPassword);

  return userMatches && passwordMatches;
}
