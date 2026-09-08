import { AppHeader } from "@/components/app-header";
import { requireSession } from "@/lib/auth/guard";

/**
 * Same gate as /shipments: the proxy redirect is optimistic, so the session is
 * verified here, inside the render, next to the Prisma queries it protects.
 *
 * Nothing links to this segment — it is reachable by URL only — which is
 * exactly why the check cannot live in the navigation.
 */
export default async function JumioDashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="min-h-svh">
      <AppHeader username={session.username} />
      {children}
    </div>
  );
}
