import { badRequest, readJson, tripNotFound, tripNotStarted } from "@/lib/radar/http";
import { recordLocations } from "@/lib/radar/service";
import { parseLocation } from "@/lib/radar/validation";

/**
 * `POST /api/radar-tracking/trips/{tripId}/locations` — one position from the
 * Radar SDK's location listener, forwarded for the route line.
 *
 * Resending the same id is accepted and stored once. A trip that has not been
 * started yet is a 409.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ tripId: string }> },
): Promise<Response> {
  const parsed = parseLocation(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const { tripId } = await context.params;
  const result = await recordLocations(tripId, [parsed.value]);

  if (result.outcome === "not_found") return tripNotFound();
  if (result.outcome === "not_started") return tripNotStarted();

  return Response.json({ success: true, duplicate: result.inserted === 0 });
}
