import { after } from "next/server";

import { sessionNotFound } from "@/lib/tracking/http";
import { refreshDrivenRoute, stopSession } from "@/lib/tracking/service";

/**
 * `POST /api/tracking/sessions/{sessionId}/stop` — the device pressed Stop.
 *
 * Completes the Radar trip and deletes both fences. A Radar failure does not
 * fail the stop — it is shown on the session page as `radarSyncError`.
 *
 * Stopping a session that is not active is a 409, so a device that thinks it
 * is still tracking finds out it is not.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const { sessionId } = await context.params;
  const result = await stopSession(sessionId);

  if (result.outcome === "not_found") return sessionNotFound();

  // The final snap of the driven line, with every point the phone sent live.
  // Points flushed after Stop are snapped as they arrive.
  if (result.outcome === "stopped") after(() => refreshDrivenRoute(sessionId, { force: true }));

  const { session } = result;
  const body = {
    sessionId: session.id,
    status: session.status,
    tripStatus: session.tripStatus,
    endedAt: session.endedAt,
    radarSyncError: session.radarSyncError,
  };

  return result.outcome === "stopped"
    ? Response.json({ success: true, ...body })
    : Response.json({ success: false, error: "Tracking session is not active.", ...body }, { status: 409 });
}
