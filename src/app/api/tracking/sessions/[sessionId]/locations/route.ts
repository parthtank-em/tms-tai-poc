import { badRequest, readJson, sessionNotFound, sessionNotStarted } from "@/lib/tracking/http";
import { recordLocations } from "@/lib/tracking/service";
import { parseLocation } from "@/lib/tracking/validation";

/**
 * `POST /api/tracking/sessions/{sessionId}/locations` — one position from the
 * Radar SDK's location listener, forwarded for the route line.
 *
 * Resending the same id is accepted and stored once. A session that has not
 * been started yet is a 409.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const parsed = parseLocation(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const { sessionId } = await context.params;
  const result = await recordLocations(sessionId, [parsed.value]);

  if (result.outcome === "not_found") return sessionNotFound();
  if (result.outcome === "not_started") return sessionNotStarted();

  return Response.json({ success: true, duplicate: result.inserted === 0 });
}
