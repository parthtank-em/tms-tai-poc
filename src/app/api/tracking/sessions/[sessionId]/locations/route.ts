import { after } from "next/server";

import { badRequest, readJson, sessionNotFound, sessionNotStarted } from "@/lib/tracking/http";
import { recordLocations, refreshDrivenRoute, refreshWeather } from "@/lib/tracking/service";
import { parseLocation } from "@/lib/tracking/validation";

/**
 * `POST /api/tracking/sessions/{sessionId}/locations` — one position from the
 * Radar SDK's location listener, forwarded for the route line.
 *
 * Resending the same id is accepted and stored once. A session that has not
 * been started yet is a 409. The answer carries the current `routeVersion`,
 * so a phone drawing an older route knows to fetch `/route`, and the current
 * `weatherVersion`, so a phone behind on it knows to fetch `/weather`.
 *
 * After answering, the driven line is snapped to roads again when enough new
 * points have arrived, and the weather ahead is checked again when the last
 * check is half an hour old — never on the phone's time.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const parsed = parseLocation(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const { sessionId } = await context.params;
  const result = await recordLocations(sessionId, [parsed.value]);

  if (result.outcome === "not_found") return sessionNotFound();
  if (result.outcome === "not_started") return sessionNotStarted();

  after(() => refreshDrivenRoute(sessionId));
  after(() => refreshWeather(sessionId));

  return Response.json({
    success: true,
    duplicate: result.inserted === 0,
    routeVersion: result.routeVersion,
    weatherVersion: result.weatherVersion,
  });
}
