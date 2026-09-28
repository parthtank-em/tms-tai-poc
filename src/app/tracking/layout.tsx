import { AppHeader } from "@/components/app-header";
import { requireSession } from "@/lib/auth/guard";

/**
 * Same gate as the other console segments: the proxy redirect is optimistic, so
 * the session is verified here, inside the render.
 *
 * Only the web side is gated. The device endpoints under /api/tracking are
 * open for this POC — see the note on `POST /api/tracking/sessions`.
 */
export default async function TrackingLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="min-h-svh">
      <AppHeader username={session.username} />
      {children}
    </div>
  );
}
