import { NextResponse, type NextRequest } from "next/server";

import { readSessionToken, sessionCookie } from "@/lib/auth/session";

/**
 * Optimistic auth gate (Next 16 renamed `middleware` to `proxy`).
 *
 * This only reads the signed cookie — no database work, because proxy runs on
 * every matched request including prefetches. It is a redirect convenience, not
 * the security boundary: `src/app/shipments/layout.tsx` re-checks the session
 * next to the queries it protects.
 */
export function proxy(request: NextRequest) {
  const token = request.cookies.get(sessionCookie.name)?.value;

  if (readSessionToken(token)) {
    return NextResponse.next();
  }

  const login = new URL("/login", request.url);
  login.searchParams.set("from", request.nextUrl.pathname + request.nextUrl.search);

  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/shipments/:path*"],
};
