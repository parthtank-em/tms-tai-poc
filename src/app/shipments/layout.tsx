import Link from "next/link";

import { logoutAction } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { requireSession } from "@/lib/auth/guard";

/**
 * The real gate for everything under /shipments.
 *
 * `proxy.ts` already redirects unauthenticated traffic, but that check is
 * optimistic and sits outside the render. Verifying here means no page in this
 * segment can query Prisma without a valid session, even if the proxy matcher
 * is later changed or bypassed.
 */
export default async function ShipmentsLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="min-h-svh">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-6 py-3">
          <Link href="/shipments" className="text-sm font-semibold tracking-tight">
            FreightID
          </Link>

          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{session.username}</span>
            <form action={logoutAction}>
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>

      {children}
    </div>
  );
}
