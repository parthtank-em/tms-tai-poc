import { sessionNotFound } from "@/lib/tracking/http";
import { getCurrentRoute } from "@/lib/tracking/service";

/**
 * `GET /api/tracking/sessions/{sessionId}/route` — the route the driver should
 * follow now, for the phone to draw: version, distance, duration and a Google
 * encoded polyline. The planned route until the driver is rerouted, then the
 * latest reroute.
 *
 * The phone calls it after Start, and again whenever a response's
 * `routeVersion` is higher than the version it is drawing.
 *
 * Unauthenticated, like the other device endpoints.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const { sessionId } = await context.params;
  const result = await getCurrentRoute(sessionId);

  if (result.outcome === "not_found") return sessionNotFound();
  return Response.json({ route: result.route });
}
