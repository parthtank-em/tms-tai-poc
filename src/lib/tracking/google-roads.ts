import type { Coordinates } from "./types";

/**
 * Google's Roads API (Snap to Roads) — turns the phone's GPS points into the
 * road line the driver actually followed, for the dashboard. Display only:
 * the stored points themselves are never changed.
 *
 * Server-side only, with the same key as the Routes API (`getGoogleRoutesKey`).
 * The Cloud project needs the Roads API enabled and the key allowed to call it.
 *
 * Off unless GOOGLE_ROADS_ENABLED is "true": until then nothing calls Google
 * and the dashboard draws the raw points.
 *
 * @see https://developers.google.com/maps/documentation/roads/snap
 */

export function isRoadsEnabled(): boolean {
  return process.env.GOOGLE_ROADS_ENABLED?.trim().toLowerCase() === "true";
}

const ENDPOINT = "https://roads.googleapis.com/v1/snapToRoads";
const TIMEOUT_MS = 15_000;

/** Snap to Roads takes at most 100 points per request. */
const MAX_POINTS_PER_REQUEST = 100;

export type SnapResult = { ok: true; path: [number, number][] } | { ok: false; message: string };

type SnapResponse = {
  snappedPoints?: { location?: { latitude?: number; longitude?: number } }[];
  error?: { message?: string };
};

/**
 * Snaps points in capture order, with `interpolate` so the line follows the
 * road between them. Long routes go in chunks of 100 that share one point, so
 * the pieces join up. Returns `[longitude, latitude]` pairs.
 */
export async function snapToRoads(apiKey: string, points: Coordinates[]): Promise<SnapResult> {
  const path: [number, number][] = [];

  for (let start = 0; start < points.length - 1; start += MAX_POINTS_PER_REQUEST - 1) {
    const chunk = points.slice(start, start + MAX_POINTS_PER_REQUEST);
    const result = await snapChunk(apiKey, chunk);
    if (!result.ok) return result;

    // The first point of each later chunk repeats the last of the previous one.
    path.push(...(path.length > 0 ? result.path.slice(1) : result.path));
  }

  return { ok: true, path };
}

async function snapChunk(apiKey: string, points: Coordinates[]): Promise<SnapResult> {
  const params = new URLSearchParams({
    path: points.map((point) => `${point.latitude},${point.longitude}`).join("|"),
    interpolate: "true",
    key: apiKey,
  });

  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}?${params}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    return { ok: false, message: `Google Roads request failed: ${(error as Error).message}` };
  }

  const json = (await response.json().catch(() => null)) as SnapResponse | null;

  if (!response.ok) {
    const detail = json?.error?.message ?? response.statusText;
    return { ok: false, message: `Google Roads → HTTP ${response.status}: ${detail}` };
  }

  const path: [number, number][] = [];
  for (const snapped of json?.snappedPoints ?? []) {
    const latitude = snapped.location?.latitude;
    const longitude = snapped.location?.longitude;
    if (typeof latitude === "number" && typeof longitude === "number") path.push([longitude, latitude]);
  }

  return { ok: true, path };
}
