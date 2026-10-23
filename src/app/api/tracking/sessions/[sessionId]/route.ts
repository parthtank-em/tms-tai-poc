import { sessionNotFound } from "@/lib/tracking/http";
import { findSession } from "@/lib/tracking/service";

/**
 * `GET /api/tracking/sessions/{sessionId}` — one session, for the phone's trip
 * detail screen and the web map. Unauthenticated, like the other device
 * endpoints.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const { sessionId } = await context.params;
  const session = await findSession(sessionId);

  return session ? Response.json(session) : sessionNotFound();
}
