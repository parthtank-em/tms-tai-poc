import { badRequest, readJson, sessionNotFound } from "@/lib/tracking/http";
import { recordGeofenceEvents } from "@/lib/tracking/service";
import { parseGeofenceEvents } from "@/lib/tracking/validation";

/**
 * `POST /api/tracking/sessions/{sessionId}/geofence-events` — crossings the
 * device detected, live or from its offline queue.
 *
 * One endpoint for both: a live crossing is a batch of one, and `isOffline` on
 * each event says which it was. `target` says which fence was crossed — START
 * or DESTINATION. Idempotent on event id, like the bulk
 * locations endpoint, so a batch whose response was lost can be resent as is.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const parsed = parseGeofenceEvents(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const { sessionId } = await context.params;
  const result = await recordGeofenceEvents(sessionId, parsed.value);

  if (result.outcome === "not_found") return sessionNotFound();
  if (result.outcome === "no_geofence") {
    return Response.json(
      {
        success: false,
        error: `This tracking session has no ${result.target === "START" ? "start" : "destination"} geofence.`,
      },
      { status: 409 },
    );
  }

  return Response.json({
    success: true,
    inserted: result.inserted,
    skipped: parsed.value.length - result.inserted,
  });
}
