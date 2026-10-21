import { getSession } from "@/lib/auth/guard";
import { DESTINATION_GEOFENCE_TAG, START_GEOFENCE_TAG, TRIP_MODE } from "@/lib/radar/config";
import { badRequest, readJson, unauthorized } from "@/lib/radar/http";
import { listTrips, startTrip } from "@/lib/radar/service";
import { parseStartTrip } from "@/lib/radar/validation";

/**
 * `POST /api/radar-tracking/trips` — the device pressed Start.
 *
 * Creates both Radar geofences and the Radar trip before answering, so by the
 * time the phone has a `tripId` Radar is ready to evaluate its locations. The
 * `radar` block is what the phone needs if it also calls `Radar.startTrip`.
 *
 * Unauthenticated, like the /tracking device endpoints: the mobile app has no
 * console session. Revisit before anything real reports here.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = parseStartTrip(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const result = await startTrip(parsed.value);

  if (result.outcome === "unconfigured") {
    return Response.json(
      {
        success: false,
        error: "Radar is not configured. Set RADAR_SECRET_KEY and NEXT_PUBLIC_RADAR_PUBLISHABLE_KEY.",
      },
      { status: 503 },
    );
  }

  if (result.outcome === "radar_failed") {
    return Response.json({ success: false, error: result.message }, { status: 502 });
  }

  const { trip } = result;

  return Response.json(
    {
      tripId: trip.id,
      status: trip.status,
      tripStatus: trip.tripStatus,
      startedAt: trip.startedAt,
      start: trip.start,
      destination: trip.destination,
      radar: {
        userId: trip.deviceId,
        externalId: trip.id,
        mode: TRIP_MODE,
        startGeofenceTag: START_GEOFENCE_TAG,
        destinationGeofenceTag: DESTINATION_GEOFENCE_TAG,
        destinationGeofenceExternalId: trip.id,
      },
    },
    { status: 201 },
  );
}

/** `GET /api/radar-tracking/trips` — every trip, newest first. Console login required. */
export async function GET(): Promise<Response> {
  if (!(await getSession())) return unauthorized();

  return Response.json(await listTrips());
}
