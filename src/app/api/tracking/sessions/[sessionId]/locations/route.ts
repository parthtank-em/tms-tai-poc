import { getSession } from "@/lib/auth/guard";
import { badRequest, readJson, sessionNotFound } from "@/lib/tracking/http";
import { listLocations, recordLocations } from "@/lib/tracking/service";
import { parseAfter, parseLocation } from "@/lib/tracking/validation";

type Context = { params: Promise<{ sessionId: string }> };

/**
 * `POST /api/tracking/sessions/{sessionId}/locations` — one live position.
 *
 * Resending a location with the same id is accepted and stored once, so the
 * device can retry a send whose response it never saw.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const parsed = parseLocation(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const { sessionId } = await context.params;
  const result = await recordLocations(sessionId, [parsed.value]);

  if (!result.found) return sessionNotFound();

  return Response.json({ success: true, duplicate: result.inserted === 0 });
}

/**
 * `GET /api/tracking/sessions/{sessionId}/locations[?after=<cursor>]`
 *
 * Without `after`, the whole route. With it, only what arrived since — pass the
 * `cursor` from the previous response. See `listLocations` for why the cursor
 * tracks arrival rather than capture time.
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  if (!(await getSession())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const after = parseAfter(new URL(request.url).searchParams.get("after"));
  if (!after.ok) return badRequest(after.error);

  const { sessionId } = await context.params;
  const locations = await listLocations(sessionId, after.value);

  return locations ? Response.json(locations) : sessionNotFound();
}
