import { getSession } from "@/lib/auth/guard";
import { badRequest, readJson } from "@/lib/tracking/http";
import { TRACKING_DESTINATION_GEOFENCE_TAG, TRACKING_START_GEOFENCE_TAG } from "@/lib/tracking/radar";
import { listSessions, startSession } from "@/lib/tracking/service";
import { parseStartSession } from "@/lib/tracking/validation";

/**
 * `POST /api/tracking/sessions` — the device pressed Start.
 *
 * `start` and `destination` are required, each a point with a geofence
 * radius. The server creates both circles in Radar, scoped to `deviceId`, and
 * Radar reports the crossings by webhook — the device only runs the Radar SDK.
 * `distanceMeters` and `eta` are the phone's own route figures (Google); the
 * server stores them as reported.
 *
 * Unauthenticated: authentication is out of scope for this POC (plan §1), and
 * the mobile app has no console session to present. Revisit before anything
 * real reports locations here.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = parseStartSession(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const result = await startSession(parsed.value);

  if (result.outcome === "unconfigured") {
    return Response.json(
      {
        success: false,
        error: "Radar is not configured on the server (RADAR_SECRET_KEY, NEXT_PUBLIC_RADAR_PUBLISHABLE_KEY).",
      },
      { status: 503 },
    );
  }
  if (result.outcome === "radar_failed") {
    return Response.json({ success: false, error: result.message }, { status: 502 });
  }

  const { session } = result;

  return Response.json(
    {
      sessionId: session.id,
      status: session.status,
      startedAt: session.startedAt,
      start: session.start,
      destination: session.destination,
      distanceMeters: session.distanceMeters,
      eta: session.eta,
      radar: {
        userId: session.deviceId,
        startGeofenceTag: TRACKING_START_GEOFENCE_TAG,
        destinationGeofenceTag: TRACKING_DESTINATION_GEOFENCE_TAG,
        geofenceExternalId: session.id,
      },
    },
    { status: 201 },
  );
}

/**
 * `GET /api/tracking/sessions` — every session, newest first, for the web list.
 *
 * Unlike the device endpoints this one is behind the console login: it is
 * only ever called from a signed-in browser, which already carries the cookie.
 */
export async function GET(): Promise<Response> {
  if (!(await getSession())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return Response.json(await listSessions());
}
