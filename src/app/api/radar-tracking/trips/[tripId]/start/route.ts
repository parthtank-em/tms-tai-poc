import { DESTINATION_GEOFENCE_TAG, START_GEOFENCE_TAG, TRIP_MODE } from "@/lib/radar/config";
import { badRequest, radarUnconfigured, readJson, tripNotFound } from "@/lib/radar/http";
import { startTrip } from "@/lib/radar/service";
import { parseStartTrip } from "@/lib/radar/validation";

/**
 * `POST /api/radar-tracking/trips/{tripId}/start` — a phone starts a planned trip.
 *
 * Creates both Radar geofences and the Radar trip for this device before
 * answering, so by the time the phone hears back Radar is ready to evaluate
 * its locations. The `radar` block is what the phone needs if it also calls
 * `Radar.startTrip`.
 *
 * Once only: a trip that is already ACTIVE or COMPLETED is a 409, whichever
 * phone started it. A Radar failure is a 502 and leaves the trip PLANNED, so
 * the phone can retry.
 *
 * Unauthenticated, like the other device endpoints.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ tripId: string }> },
): Promise<Response> {
  const parsed = parseStartTrip(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const { tripId } = await context.params;
  const result = await startTrip(tripId, parsed.value);

  switch (result.outcome) {
    case "not_found":
      return tripNotFound();
    case "unconfigured":
      return radarUnconfigured();
    case "radar_failed":
      return Response.json({ success: false, error: result.message }, { status: 502 });
    case "not_planned":
      return Response.json(
        {
          success: false,
          error: "Radar trip has already been started.",
          tripId: result.trip.id,
          status: result.trip.status,
          deviceId: result.trip.deviceId,
          startedAt: result.trip.startedAt,
        },
        { status: 409 },
      );
  }

  const { trip } = result;

  return Response.json({
    tripId: trip.id,
    status: trip.status,
    tripStatus: trip.tripStatus,
    startedAt: trip.startedAt,
    start: trip.start,
    destination: trip.destination,
    planned: trip.planned,
    radar: {
      userId: trip.deviceId,
      externalId: trip.id,
      mode: TRIP_MODE,
      startGeofenceTag: START_GEOFENCE_TAG,
      destinationGeofenceTag: DESTINATION_GEOFENCE_TAG,
      destinationGeofenceExternalId: trip.id,
    },
  });
}
