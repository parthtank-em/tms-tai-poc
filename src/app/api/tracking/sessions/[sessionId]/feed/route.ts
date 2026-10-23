import { getSession } from "@/lib/auth/guard";
import { badRequest, sessionNotFound } from "@/lib/tracking/http";
import { getFeed } from "@/lib/tracking/service";
import { parseAfter } from "@/lib/tracking/validation";

/**
 * `GET /api/tracking/sessions/{sessionId}/feed[?after=<cursor>]` — the session
 * page's poll: the session's current status and ETA, plus the locations and
 * Radar events received since the cursor. Console login required.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  if (!(await getSession())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const after = parseAfter(new URL(request.url).searchParams.get("after"));
  if (!after.ok) return badRequest(after.error);

  const { sessionId } = await context.params;
  const feed = await getFeed(sessionId, after.value);

  return feed ? Response.json(feed) : sessionNotFound();
}
