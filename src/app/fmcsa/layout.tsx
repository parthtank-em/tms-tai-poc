import { AppHeader } from "@/components/app-header";
import { requireSession } from "@/lib/auth/guard";

/**
 * Same gate as the other console segments: the proxy redirect is optimistic, so
 * the session is verified here, inside the render.
 *
 * This POC holds no data of its own — it calls FMCSA and shows the answer — but
 * the check still matters, because the call spends this deployment's webKey.
 */
export default async function FmcsaLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="min-h-svh">
      <AppHeader username={session.username} />
      {children}
    </div>
  );
}
