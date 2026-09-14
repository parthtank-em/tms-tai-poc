import { AppHeader } from "@/components/app-header";
import { requireSession } from "@/lib/auth/guard";

/**
 * Same gate as the other console segments: the proxy redirect is optimistic, so
 * the session is verified here, inside the render.
 *
 * This POC holds no data of its own, but the check still matters — each lookup
 * spends a metered call against this deployment's API key.
 */
export default async function PlateLookupLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="min-h-svh">
      <AppHeader username={session.username} />
      {children}
    </div>
  );
}
