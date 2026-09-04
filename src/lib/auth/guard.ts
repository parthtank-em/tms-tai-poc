import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { readSessionToken, sessionCookie, type Session } from "./session";

/**
 * Server-side session access.
 *
 * `proxy.ts` also redirects unauthenticated traffic away from protected routes,
 * but that is an optimistic check. This is the one that actually gates data:
 * it runs inside the render, next to the Prisma queries it protects.
 */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return readSessionToken(store.get(sessionCookie.name)?.value);
}

/** Redirects to the login page when there is no valid session. */
export async function requireSession(returnTo?: string): Promise<Session> {
  const session = await getSession();

  if (!session) {
    const target = returnTo ? `/login?from=${encodeURIComponent(returnTo)}` : "/login";
    redirect(target);
  }

  return session;
}
