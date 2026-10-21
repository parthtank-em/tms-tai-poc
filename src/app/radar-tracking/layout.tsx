import { AppHeader } from "@/components/app-header";
import { requireSession } from "@/lib/auth/guard";

/**
 * Same gate as the other console segments: the proxy redirect is optimistic, so
 * the session is verified here, inside the render.
 *
 * Only the web side is gated. The device endpoints under /api/radar-tracking
 * and the Radar webhook are open — see the notes on those routes.
 */
export default async function RadarTrackingLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="min-h-svh">
      <AppHeader username={session.username} />
      {children}
    </div>
  );
}
