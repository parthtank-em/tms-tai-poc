import type { Coordinates, RoutePreview } from "./types";

/**
 * Google's Routes API — the /tracking POC's planned route, distance and ETA.
 * (The Radar POC routes with Radar instead.)
 *
 * Server-side only. Uses GOOGLE_MAPS_SERVER_API_KEY, a key meant for server
 * calls; when that is not set it falls back to the browser key, which works as
 * long as that key is not restricted to the app's web origins.
 *
 * @see https://developers.google.com/maps/documentation/routes/compute_route_directions
 */

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const TIMEOUT_MS = 15_000;

/** The line is stored on the session and sent to the browser; this is enough to draw it smoothly. */
const MAX_PATH_POINTS = 500;

/** Only the fields we read — Google bills by the fields requested. */
const FIELD_MASK = "routes.distanceMeters,routes.duration,routes.polyline.geoJsonLinestring";

export function getGoogleRoutesKey(): string | null {
  return (
    process.env.GOOGLE_MAPS_SERVER_API_KEY?.trim() ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ||
    null
  );
}

export type GoogleRouteResult = { ok: true; route: RoutePreview } | { ok: false; message: string };

type ComputeRoutesResponse = {
  routes?: {
    distanceMeters?: number;
    /** Seconds, as a string like "9920s". */
    duration?: string;
    polyline?: { geoJsonLinestring?: { coordinates?: [number, number][] } };
  }[];
  error?: { message?: string };
};

/**
 * The drive route between two points, with live traffic (TRAFFIC_AWARE): the
 * duration is how long it would take leaving now.
 */
export async function computeRoute(
  apiKey: string,
  origin: Coordinates,
  destination: Coordinates,
): Promise<GoogleRouteResult> {
  let response: Response;

  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      // Only the two coordinates: Google rejects any other field in `latLng`,
      // and callers may pass a whole trip end (address, radius).
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: origin.latitude, longitude: origin.longitude } } },
        destination: {
          location: { latLng: { latitude: destination.latitude, longitude: destination.longitude } },
        },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        polylineEncoding: "GEO_JSON_LINESTRING",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    return { ok: false, message: `Google Routes request failed: ${(error as Error).message}` };
  }

  const json = (await response.json().catch(() => null)) as ComputeRoutesResponse | null;

  if (!response.ok) {
    const detail = json?.error?.message ?? response.statusText;
    return { ok: false, message: `Google Routes → HTTP ${response.status}: ${detail}` };
  }

  const route = json?.routes?.[0];
  const seconds = Number.parseFloat(route?.duration ?? "");
  if (!route || typeof route.distanceMeters !== "number" || !Number.isFinite(seconds)) {
    return { ok: false, message: "Google found no drive route between the two points." };
  }

  return {
    ok: true,
    route: {
      distanceMeters: route.distanceMeters,
      durationMinutes: seconds / 60,
      path: thin(route.polyline?.geoJsonLinestring?.coordinates ?? []),
    },
  };
}

/** Keeps every n-th point (and always the last) so a long route stays at most MAX_PATH_POINTS. */
function thin(path: [number, number][]): [number, number][] {
  if (path.length <= MAX_PATH_POINTS) return path;

  const step = Math.ceil(path.length / MAX_PATH_POINTS);
  const kept = path.filter((_, index) => index % step === 0);
  if (kept.at(-1) !== path.at(-1)) kept.push(path.at(-1)!);
  return kept;
}
