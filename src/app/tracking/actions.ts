"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/guard";
import {
  deletePlannedSession,
  planSession,
  previewRoute,
  previewWeather,
  replanSession,
  type PreviewRouteResult,
} from "@/lib/tracking/service";
import type { RoutePreview, WeatherPreview } from "@/lib/tracking/types";
import { parsePlanSession } from "@/lib/tracking/validation";

/**
 * The portal's session planner. Every action re-checks the login: a server
 * action is reachable by a direct POST, not only from the form that shows it.
 *
 * Only `async function` exports are allowed beside `"use server"` — types are
 * erased and so permitted.
 */

/** `weather` is null when the Weather API is off (GOOGLE_WEATHER_ENABLED). */
export type PreviewState =
  | { ok: true; route: RoutePreview; weather: WeatherPreview | null }
  | { ok: false; error: string };

export type SaveState = { ok: true; sessionId: string } | { ok: false; error: string };

const UNCONFIGURED =
  "Google routing is not configured. Set GOOGLE_MAPS_SERVER_API_KEY (or NEXT_PUBLIC_GOOGLE_MAPS_API_KEY).";

function routeError(result: Exclude<PreviewRouteResult, { outcome: "routed" }>): string {
  return result.outcome === "unconfigured" ? UNCONFIGURED : result.message;
}

/** Google's route for the form's two points, and the weather along it leaving now. Saves nothing. */
export async function previewRouteAction(input: unknown): Promise<PreviewState> {
  await requireSession();

  const parsed = parsePlanSession(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const result = await previewRoute(parsed.value.start, parsed.value.destination);
  if (result.outcome !== "routed") return { ok: false, error: routeError(result) };

  return { ok: true, route: result.route, weather: await previewWeather(result.route) };
}

export async function createSessionAction(input: unknown): Promise<SaveState> {
  await requireSession();

  const parsed = parsePlanSession(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const result = await planSession(parsed.value);
  if (result.outcome !== "planned") return { ok: false, error: routeError(result) };

  revalidatePath("/tracking");
  return { ok: true, sessionId: result.session.id };
}

export async function updateSessionAction(sessionId: string, input: unknown): Promise<SaveState> {
  await requireSession();

  const parsed = parsePlanSession(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const result = await replanSession(sessionId, parsed.value);

  switch (result.outcome) {
    case "planned":
      revalidatePath("/tracking");
      revalidatePath(`/tracking/${sessionId}`);
      return { ok: true, sessionId };
    case "not_found":
      return { ok: false, error: "This session no longer exists." };
    case "not_planned":
      return { ok: false, error: "A phone has already started this session, so it can no longer be edited." };
    default:
      return { ok: false, error: routeError(result) };
  }
}

export async function deleteSessionAction(
  sessionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireSession();

  const result = await deletePlannedSession(sessionId);

  switch (result.outcome) {
    case "deleted":
    case "not_found":
      // Gone either way, which is what the user asked for.
      revalidatePath("/tracking");
      return { ok: true };
    case "not_planned":
      return { ok: false, error: "A phone has already started this session, so it can no longer be deleted." };
  }
}
