"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/guard";
import {
  deletePlannedTrip,
  planTrip,
  previewRoute,
  replanTrip,
  type PreviewRouteResult,
} from "@/lib/radar/service";
import type { RoutePreview } from "@/lib/radar/types";
import { parsePlanTrip } from "@/lib/radar/validation";

/**
 * The portal's trip planner. Every action re-checks the session: a server
 * action is reachable by a direct POST, not only from the form that shows it.
 *
 * Only `async function` exports are allowed beside `"use server"` — types are
 * erased and so permitted.
 */

export type PreviewState = { ok: true; route: RoutePreview } | { ok: false; error: string };

export type SaveState = { ok: true; tripId: string } | { ok: false; error: string };

const UNCONFIGURED = "Radar is not configured. Set RADAR_SECRET_KEY and NEXT_PUBLIC_RADAR_PUBLISHABLE_KEY.";

function routeError(result: Exclude<PreviewRouteResult, { outcome: "routed" }>): string {
  return result.outcome === "unconfigured" ? UNCONFIGURED : result.message;
}

/** Radar's route for the form's two points. Saves nothing. */
export async function previewRouteAction(input: unknown): Promise<PreviewState> {
  await requireSession();

  const parsed = parsePlanTrip(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const result = await previewRoute(parsed.value.start, parsed.value.destination);
  return result.outcome === "routed" ? { ok: true, route: result.route } : { ok: false, error: routeError(result) };
}

export async function createTripAction(input: unknown): Promise<SaveState> {
  await requireSession();

  const parsed = parsePlanTrip(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const result = await planTrip(parsed.value);
  if (result.outcome !== "planned") return { ok: false, error: routeError(result) };

  revalidatePath("/radar-tracking");
  return { ok: true, tripId: result.trip.id };
}

export async function updateTripAction(tripId: string, input: unknown): Promise<SaveState> {
  await requireSession();

  const parsed = parsePlanTrip(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const result = await replanTrip(tripId, parsed.value);

  switch (result.outcome) {
    case "planned":
      revalidatePath("/radar-tracking");
      revalidatePath(`/radar-tracking/${tripId}`);
      return { ok: true, tripId };
    case "not_found":
      return { ok: false, error: "This trip no longer exists." };
    case "not_planned":
      return { ok: false, error: "A phone has already started this trip, so it can no longer be edited." };
    default:
      return { ok: false, error: routeError(result) };
  }
}

export async function deleteTripAction(tripId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireSession();

  const result = await deletePlannedTrip(tripId);

  switch (result.outcome) {
    case "deleted":
    case "not_found":
      // Gone either way, which is what the user asked for.
      revalidatePath("/radar-tracking");
      return { ok: true };
    case "not_planned":
      return { ok: false, error: "A phone has already started this trip, so it can no longer be deleted." };
  }
}
