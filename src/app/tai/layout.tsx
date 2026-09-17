import { AppHeader } from "@/components/app-header";
import { TaiNav } from "@/components/tai-nav";
import { requireSession } from "@/lib/auth/guard";

/**
 * The real gate for everything under /tai — shipments and staff alike.
 *
 * `proxy.ts` already redirects unauthenticated traffic, but that check is
 * optimistic and sits outside the render. Verifying here means no page in this
 * segment can query Prisma or reach TAI without a valid session, even if the
 * proxy matcher is later changed or bypassed.
 *
 * One layout for the whole POC rather than one per page: both halves want the
 * same chrome and the same check, and a new page under `/tai` should not have to
 * remember to bring its own.
 */
export default async function TaiLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="min-h-svh">
      <AppHeader username={session.username} />
      <TaiNav />
      {children}
    </div>
  );
}
