import { sessionNotFound } from "@/lib/tracking/http";
import { getWeather } from "@/lib/tracking/service";

/**
 * `GET /api/tracking/sessions/{sessionId}/weather` — the weather ahead, for the
 * phone: the forecast at points along the route to follow, and the alerts on
 * it that are not long past.
 *
 * The phone calls it whenever a locations response's `weatherVersion` is
 * higher than the version it has, and shows a notification for each alert id
 * it has not shown before.
 *
 * Unauthenticated, like the other device endpoints.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const { sessionId } = await context.params;
  const result = await getWeather(sessionId);

  if (result.outcome === "not_found") return sessionNotFound();
  return Response.json({ weather: result.weather });
}
