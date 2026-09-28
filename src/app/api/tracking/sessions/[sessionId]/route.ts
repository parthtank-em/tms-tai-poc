import { getSession } from "@/lib/auth/guard";
import { sessionNotFound } from "@/lib/tracking/http";
import { findSession } from "@/lib/tracking/service";

/** `GET /api/tracking/sessions/{sessionId}` — one session, for the web map. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  if (!(await getSession())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await context.params;
  const session = await findSession(sessionId);

  return session ? Response.json(session) : sessionNotFound();
}
