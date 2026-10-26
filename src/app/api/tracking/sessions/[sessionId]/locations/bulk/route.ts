import { after } from "next/server";

import { badRequest, readJson, sessionNotFound, sessionNotStarted } from "@/lib/tracking/http";
import { recordLocations, refreshDrivenRoute, refreshWeather } from "@/lib/tracking/service";
import { parseBulkLocations } from "@/lib/tracking/validation";

/**
 * `POST /api/tracking/sessions/{sessionId}/locations/bulk` — the offline queue.
 *
 * Idempotent on location id: resending a batch after a lost response inserts
 * nothing new, and `inserted` says so. `skipped` lets the device tell a retry
 * apart from a first send. `routeVersion` is the route to follow now, and
 * `weatherVersion` the weather alerts' version — fetch `/weather` when higher.
 *
 * After answering, the driven line is snapped to roads again, and the weather
 * ahead is checked again when due.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const parsed = parseBulkLocations(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const { sessionId } = await context.params;
  const result = await recordLocations(sessionId, parsed.value);

  if (result.outcome === "not_found") return sessionNotFound();
  if (result.outcome === "not_started") return sessionNotStarted();

  after(() => refreshDrivenRoute(sessionId));
  after(() => refreshWeather(sessionId));

  return Response.json({
    success: true,
    inserted: result.inserted,
    skipped: parsed.value.length - result.inserted,
    routeVersion: result.routeVersion,
    weatherVersion: result.weatherVersion,
  });
}
