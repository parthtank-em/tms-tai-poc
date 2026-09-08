import { AppHeader } from "@/components/app-header";
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
      <AppHeader username={session.username} />
      {children}
    </div>
  );
}
