import { DESTINATION_GEOFENCE_TAG, START_GEOFENCE_TAG, TRIP_MODE, type RadarConfig } from "./config";
import type { Geofence, RadarGeofenceTarget } from "./types";

/**
 * Thin client for the Radar REST API — only the calls the server makes.
 *
 * Everything location-related (track, replay, entering and leaving fences) is
 * the SDK's job on the phone; the server only sets a trip up and tears it down.
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
  method: "PUT" | "POST" | "PATCH" | "DELETE",
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
 * Creates or replaces one fence of a trip. `userIds` scopes it to the trip's
 * device: without it Radar would fire events for any user who drives through.
 */
export function upsertGeofence(
  config: RadarConfig,
  tripId: string,
  target: RadarGeofenceTarget,
  geofence: Geofence,
  deviceId: string,
): Promise<RadarResult<unknown>> {
  return request(config, config.secretKey, "PUT", `/geofences/${geofenceTag(target)}/${tripId}`, {
    description: `${target === "START" ? "Start" : "Destination"} of trip ${tripId}`,
    type: "circle",
    // GeoJSON order: longitude first.
    coordinates: [geofence.longitude, geofence.latitude],
    radius: geofence.radiusMeters,
    userIds: deviceId,
    metadata: { tripId },
  });
}

export function deleteGeofence(
  config: RadarConfig,
  tripId: string,
  target: RadarGeofenceTarget,
): Promise<RadarResult<unknown>> {
  return request(config, config.secretKey, "DELETE", `/geofences/${geofenceTag(target)}/${tripId}`);
}

/** Starts a Radar trip whose destination is the trip's destination fence. */
export async function createTrip(
  config: RadarConfig,
  tripId: string,
  deviceId: string,
): Promise<RadarResult<RadarTripResponse>> {
  const result = await request<{ trip?: RadarTripResponse }>(
    config,
    config.publishableKey,
    "POST",
    "/trips",
    {
      externalId: tripId,
      userId: deviceId,
      mode: TRIP_MODE,
      destinationGeofenceTag: DESTINATION_GEOFENCE_TAG,
      destinationGeofenceExternalId: tripId,
    },
  );

  if (!result.ok) return result;
  if (!result.data.trip) return { ok: false, message: "Radar POST /trips returned no trip." };

  return { ok: true, data: result.data.trip };
}

export function updateTripStatus(
  config: RadarConfig,
  tripId: string,
  status: "completed" | "canceled",
): Promise<RadarResult<unknown>> {
  return request(config, config.publishableKey, "PATCH", `/trips/${tripId}/update`, { status });
}
