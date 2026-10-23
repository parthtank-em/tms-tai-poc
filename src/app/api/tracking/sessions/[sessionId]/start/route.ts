import { TRIP_MODE } from "@/lib/radar/config";
import { badRequest, readJson, sessionNotFound } from "@/lib/tracking/http";
import {
  sessionTripExternalId,
  TRACKING_DESTINATION_GEOFENCE_TAG,
  TRACKING_START_GEOFENCE_TAG,
} from "@/lib/tracking/radar";
import { startSession } from "@/lib/tracking/service";
import { parseStartSession } from "@/lib/tracking/validation";

/**
 * `POST /api/tracking/sessions/{sessionId}/start` — a phone starts a planned session.
 *
 * Creates both Radar geofences and the Radar trip for this device before
 * answering, so by the time the phone hears back Radar is ready to evaluate
 * its locations. The `radar` block is what the phone needs if it also calls
 * `Radar.startTrip`.
 *
 * Once only: a session that is already ACTIVE or COMPLETED is a 409, whichever
 * phone started it. A Radar failure is a 502 and leaves the session PLANNED,
 * so the phone can retry.
 *
 * Unauthenticated, like the other device endpoints.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const parsed = parseStartSession(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const { sessionId } = await context.params;
  const result = await startSession(sessionId, parsed.value);

  switch (result.outcome) {
    case "not_found":
      return sessionNotFound();
    case "unconfigured":
      return Response.json(
        {
          success: false,
          error: "Radar is not configured on the server (RADAR_SECRET_KEY, NEXT_PUBLIC_RADAR_PUBLISHABLE_KEY).",
        },
        { status: 503 },
      );
    case "radar_failed":
      return Response.json({ success: false, error: result.message }, { status: 502 });
    case "not_planned":
      return Response.json(
        {
          success: false,
          error: "Tracking session has already been started.",
          sessionId: result.session.id,
          status: result.session.status,
          deviceId: result.session.deviceId,
          startedAt: result.session.startedAt,
        },
        { status: 409 },
      );
  }

  const { session } = result;

  return Response.json({
    sessionId: session.id,
    status: session.status,
    tripStatus: session.tripStatus,
    startedAt: session.startedAt,
    start: session.start,
    destination: session.destination,
    planned: session.planned,
    radar: {
      userId: session.deviceId,
      externalId: sessionTripExternalId(session.id),
      mode: TRIP_MODE,
      startGeofenceTag: TRACKING_START_GEOFENCE_TAG,
      destinationGeofenceTag: TRACKING_DESTINATION_GEOFENCE_TAG,
      destinationGeofenceExternalId: session.id,
    },
  });
}
