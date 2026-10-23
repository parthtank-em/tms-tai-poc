import { badRequest, readJson } from "@/lib/tracking/http";
import { listSessions, planSession } from "@/lib/tracking/service";
import { parsePlanSession, parseStatusFilter } from "@/lib/tracking/validation";

/**
 * `GET /api/tracking/sessions[?status=PLANNED]` — every session, newest first.
 *
 * The phone's trip list: it shows the PLANNED ones a driver can start.
 *
 * Unauthenticated, like the other device endpoints: the mobile app has no
 * console session. Revisit before anything real reports here.
 */
export async function GET(request: Request): Promise<Response> {
  const status = parseStatusFilter(new URL(request.url).searchParams.get("status"));
  if (!status.ok) return badRequest(status.error);

  return Response.json(await listSessions(status.value));
}

/**
 * `POST /api/tracking/sessions` — optional for the app: the phone plans a
 * session, as the portal's Add trip does. Two ends, each a point, a geofence
 * radius and an optional address. Google's traffic-aware drive route is
 * computed and stored with it.
 *
 * The session is PLANNED, not started — the phone starts it with
 * `POST /sessions/{sessionId}/start`, the same as a session planned on the
 * portal. So the fences in Radar are only ever created at Start.
 *
 * Unauthenticated, like the other device endpoints.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = parsePlanSession(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const result = await planSession(parsed.value);

  switch (result.outcome) {
    case "unconfigured":
      return Response.json(
        {
          success: false,
          error: "Google routing is not configured (GOOGLE_MAPS_SERVER_API_KEY or NEXT_PUBLIC_GOOGLE_MAPS_API_KEY).",
        },
        { status: 503 },
      );
    case "google_failed":
      return Response.json({ success: false, error: result.message }, { status: 502 });
    case "planned":
      return Response.json(result.session, { status: 201 });
  }
}
