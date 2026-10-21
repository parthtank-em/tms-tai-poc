import { getSession } from "@/lib/auth/guard";
import { badRequest, tripNotFound, unauthorized } from "@/lib/radar/http";
import { getFeed } from "@/lib/radar/service";
import { parseAfter } from "@/lib/radar/validation";

/**
 * `GET /api/radar-tracking/trips/{tripId}/feed[?after=<cursor>]` — the trip
 * page's poll: the trip's current status and ETA, plus the locations and
 * Radar events received since the cursor. Console login required.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ tripId: string }> },
): Promise<Response> {
  if (!(await getSession())) return unauthorized();

  const after = parseAfter(new URL(request.url).searchParams.get("after"));
  if (!after.ok) return badRequest(after.error);

  const { tripId } = await context.params;
  const feed = await getFeed(tripId, after.value);

  return feed ? Response.json(feed) : tripNotFound();
}
