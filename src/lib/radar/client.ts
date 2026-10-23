import { DESTINATION_GEOFENCE_TAG, START_GEOFENCE_TAG, ROUTE_MODE, TRIP_MODE, type RadarConfig } from "./config";
import type { Coordinates, Geofence, RadarGeofenceTarget } from "./types";

/**
 * Thin client for the Radar REST API — only the calls the server makes.
 *
 * Everything location-related (track, replay, entering and leaving fences) is
 * the SDK's job on the phone; the server only plans a trip (address search,
 * route), sets it up in Radar and tears it down.
 *
 * Auth is the raw key in `Authorization`, no `Bearer`.
 *
 * @see https://docs.radar.com/api
 */

const TIMEOUT_MS = 15_000;

export type RadarResult<T> = { ok: true; data: T } | { ok: false; message: string };

/** The parts of Radar's trip object the server reads. */
export type RadarTripResponse = {
  _id: string;
  externalId: string;
  status: string;
};

export function geofenceTag(target: RadarGeofenceTarget): string {
  return target === "START" ? START_GEOFENCE_TAG : DESTINATION_GEOFENCE_TAG;
}

async function request<T>(
  config: RadarConfig,
  key: string,
  method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<RadarResult<T>> {
  let response: Response;

  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: key,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    return { ok: false, message: `Radar ${method} ${path} failed: ${(error as Error).message}` };
  }

  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  if (!response.ok) {
    // Radar's errors carry `meta.message`; fall back to the status line.
    const meta = json?.meta as { message?: unknown } | undefined;
    const detail = typeof meta?.message === "string" ? meta.message : response.statusText;
    return { ok: false, message: `Radar ${method} ${path} → HTTP ${response.status}: ${detail}` };
  }

  return { ok: true, data: (json ?? {}) as T };
}

/**
 * One fence in Radar: tag + externalId name it. The Radar POC tags fences
 * `tms-radar-*` and the /tracking POC `tms-track-*`, each with its own id as
 * the externalId, so the two never address each other's fences.
 */
export type GeofenceKey = { tag: string; externalId: string };

/**
 * Creates or replaces one fence. `userIds` scopes it to one device: without it
 * Radar would fire events for any user who drives through.
 */
export function upsertGeofence(
  config: RadarConfig,
  key: GeofenceKey,
  geofence: Geofence,
  deviceId: string,
  details: { description: string; metadata: Record<string, string> },
): Promise<RadarResult<unknown>> {
  return request(config, config.secretKey, "PUT", `/geofences/${key.tag}/${key.externalId}`, {
    description: details.description,
    type: "circle",
    // GeoJSON order: longitude first.
    coordinates: [geofence.longitude, geofence.latitude],
    radius: geofence.radiusMeters,
    userIds: deviceId,
    metadata: details.metadata,
  });
}

export function deleteGeofence(config: RadarConfig, key: GeofenceKey): Promise<RadarResult<unknown>> {
  return request(config, config.secretKey, "DELETE", `/geofences/${key.tag}/${key.externalId}`);
}

/** A Radar POC trip's fence: the trip id is the externalId, the tag says which end. */
export function tripGeofence(tripId: string, target: RadarGeofenceTarget): GeofenceKey {
  return { tag: geofenceTag(target), externalId: tripId };
}

/**
 * Starts a Radar trip for one user whose destination is a fence already
 * created. Both POCs use it: the Radar POC with its trip id and `tms-radar-dest`
 * fence, /tracking with a `tms-track-…` id and its `tms-track-dest` fence.
 */
export async function createTrip(
  config: RadarConfig,
  trip: { externalId: string; userId: string; destination: GeofenceKey },
): Promise<RadarResult<RadarTripResponse>> {
  const result = await request<{ trip?: RadarTripResponse }>(
    config,
    config.publishableKey,
    "POST",
    "/trips",
    {
      externalId: trip.externalId,
      userId: trip.userId,
      mode: TRIP_MODE,
      destinationGeofenceTag: trip.destination.tag,
      destinationGeofenceExternalId: trip.destination.externalId,
    },
  );

  if (!result.ok) return result;
  if (!result.data.trip) return { ok: false, message: "Radar POST /trips returned no trip." };

  return { ok: true, data: result.data.trip };
}

/** `externalId` is the trip's external id: the Radar POC trip id, or /tracking's `tms-track-…`. */
export function updateTripStatus(
  config: RadarConfig,
  externalId: string,
  status: "completed" | "canceled",
): Promise<RadarResult<unknown>> {
  return request(config, config.publishableKey, "PATCH", `/trips/${externalId}/update`, { status });
}


/** One mode's route: distance in meters, duration in minutes, GeoJSON line. */
export type RadarRouteResponse = {
  distance?: { value: number };
  duration?: { value: number };
  geometry?: { type: "LineString"; coordinates: [number, number][] };
};

/**
 * Enough to draw a long route smoothly. Radar's full geometry runs to tens of
 * thousands of points for a long drive, and it is stored on the trip and sent
 * to the browser.
 */
const ROUTE_GEOMETRY_POINTS = 500;

/** Radar's road route between two points, by truck (see ROUTE_MODE). */
export async function routeDistance(
  config: RadarConfig,
  origin: Coordinates,
  destination: Coordinates,
): Promise<RadarResult<RadarRouteResponse>> {
  const params = new URLSearchParams({
    origin: `${origin.latitude},${origin.longitude}`,
    destination: `${destination.latitude},${destination.longitude}`,
    modes: ROUTE_MODE,
    units: "metric",
    geometry: "linestring",
    geometryPoints: String(ROUTE_GEOMETRY_POINTS),
  });
  const result = await request<{ routes?: Partial<Record<string, RadarRouteResponse>> }>(
    config,
    config.publishableKey,
    "GET",
    `/route/distance?${params}`,
  );

  if (!result.ok) return result;

  const route = result.data.routes?.[ROUTE_MODE];
  if (!route) return { ok: false, message: `Radar found no ${ROUTE_MODE} route between the two points.` };

  return { ok: true, data: route };
}
