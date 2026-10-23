import { badRequest, radarUnconfigured, readJson } from "@/lib/radar/http";
import { listTrips, planTrip } from "@/lib/radar/service";
import { parsePlanTrip, parseStatusFilter } from "@/lib/radar/validation";

/**
 * `GET /api/radar-tracking/trips[?status=PLANNED]` — every trip, newest first.
 *
 * The phone's trip list: it shows the PLANNED ones a driver can start.
 *
 * Unauthenticated, like the other device endpoints: the mobile app has no
 * console session. Revisit before anything real reports here.
 */
export async function GET(request: Request): Promise<Response> {
  const status = parseStatusFilter(new URL(request.url).searchParams.get("status"));
  if (!status.ok) return badRequest(status.error);

  return Response.json(await listTrips(status.value));
}

/**
 * `POST /api/radar-tracking/trips` — the phone plans a trip, as the portal's
 * Add trip does: two ends, each a point, a geofence radius and an optional
 * address. Radar's car route is computed and stored with it.
 *
 * The trip is PLANNED, not started — the phone starts it with
 * `POST /trips/{tripId}/start`, the same as a trip planned on the portal. So
 * there is one lifecycle, and Radar's fences are only ever created at Start.
 *
 * Unauthenticated, like the other device endpoints.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = parsePlanTrip(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const result = await planTrip(parsed.value);

  switch (result.outcome) {
    case "unconfigured":
      return radarUnconfigured();
    case "radar_failed":
      return Response.json({ success: false, error: result.message }, { status: 502 });
    case "planned":
      return Response.json(result.trip, { status: 201 });
  }
}
