import { badRequest, readJson, sessionNotFound } from "@/lib/tracking/http";
import { rerouteSession } from "@/lib/tracking/service";
import { parseReroute } from "@/lib/tracking/validation";

/**
 * `POST /api/tracking/sessions/{sessionId}/reroute` — the phone found itself
 * off the route (its own check against the route it draws). The server asks
 * Google for a route from that point to the destination and makes it the
 * route to follow; the dashboard picks it up on its next poll.
 *
 * `rerouted: false` means no new route was made — the phone was behind, or
 * the last reroute was under a minute ago — and `route` is the current one.
 * Either way, draw the `route` in the response.
 *
 * Unauthenticated, like the other device endpoints.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const parsed = parseReroute(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const { sessionId } = await context.params;
  const result = await rerouteSession(sessionId, parsed.value);

  switch (result.outcome) {
    case "not_found":
      return sessionNotFound();
    case "not_active":
      return Response.json(
        { success: false, error: "Tracking session is not active — only a started session can be rerouted." },
        { status: 409 },
      );
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
    case "rerouted":
      return Response.json({ success: true, rerouted: true, route: result.route });
    case "current":
      return Response.json({ success: true, rerouted: false, route: result.route });
  }
}
