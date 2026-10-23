import { badRequest, readJson, tripNotFound, tripNotStarted } from "@/lib/radar/http";
import { recordLocations } from "@/lib/radar/service";
import { parseBulkLocations } from "@/lib/radar/validation";

/**
 * `POST /api/radar-tracking/trips/{tripId}/locations/bulk` — the phone's
 * offline queue of route points. Idempotent on location id.
 *
 * This is only the route line. Radar gets the same offline locations through
 * the SDK's own replay, independently of this endpoint.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ tripId: string }> },
): Promise<Response> {
  const parsed = parseBulkLocations(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const { tripId } = await context.params;
  const result = await recordLocations(tripId, parsed.value);

  if (result.outcome === "not_found") return tripNotFound();
  if (result.outcome === "not_started") return tripNotStarted();

  return Response.json({
    success: true,
    inserted: result.inserted,
    skipped: parsed.value.length - result.inserted,
  });
}
