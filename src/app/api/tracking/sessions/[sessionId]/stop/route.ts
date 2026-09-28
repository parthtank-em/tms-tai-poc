import { sessionNotFound } from "@/lib/tracking/http";
import { stopSession } from "@/lib/tracking/service";

/**
 * `POST /api/tracking/sessions/{sessionId}/stop` — the device pressed Stop.
 *
 * Stopping an already-completed session is a 409 rather than a silent success,
 * so a device that thinks it is still tracking finds out it is not.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const { sessionId } = await context.params;
  const result = await stopSession(sessionId);

  if (result.outcome === "not_found") return sessionNotFound();

  const { session } = result;
  const body = { sessionId: session.id, status: session.status, endedAt: session.endedAt };

  return result.outcome === "stopped"
    ? Response.json({ success: true, ...body })
    : Response.json(
        { success: false, error: "Tracking session is not active.", ...body },
        { status: 409 },
      );
}
