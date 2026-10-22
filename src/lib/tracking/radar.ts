import type { GeofenceKey } from "@/lib/radar/client";

import type { GeofenceEventType, GeofenceTarget } from "./types";

/**
 * Radar as the /tracking POC's geofencing engine.
 *
 * The server creates each session's two fences in Radar, scoped to the
 * session's device; the Radar SDK on the phone decides inside or outside, and
 * the crossings reach us by webhook. Distance and ETA stay with the phone
 * (Google), and nothing here uses Radar trips.
 *
 * Pure — no database — so the simulator can share the tags and the mapping is
 * tested on its own.
 */

/**
 * Tags of a session's two fences; the fence `externalId` is the session id.
 * Distinct from the Radar POC's `tms-radar-*`, so the shared webhook can tell
 * the two POCs' events apart.
 */
export const TRACKING_START_GEOFENCE_TAG = "tms-track-start";
export const TRACKING_DESTINATION_GEOFENCE_TAG = "tms-track-dest";

export const TRACKING_TAG_TARGET: Record<string, GeofenceTarget> = {
  [TRACKING_START_GEOFENCE_TAG]: "START",
  [TRACKING_DESTINATION_GEOFENCE_TAG]: "DESTINATION",
};

export function sessionGeofence(sessionId: string, target: GeofenceTarget): GeofenceKey {
  return {
    tag: target === "START" ? TRACKING_START_GEOFENCE_TAG : TRACKING_DESTINATION_GEOFENCE_TAG,
    externalId: sessionId,
  };
}

const EVENT_TYPES: Record<string, GeofenceEventType> = {
  "user.entered_geofence": "ENTER",
  "user.exited_geofence": "EXIT",
};

/**
 * How far behind Radar processed an event before it counts as replayed from
 * the phone's offline queue rather than live — the Radar POC's rule too.
 */
const REPLAYED_AFTER_MS = 60_000;

/** One crossing, in the shape `TrackingGeofenceEvent` stores. */
export type TrackingRadarEvent = {
  /** Radar's event `_id`, so a redelivered webhook is stored once. */
  id: string;
  sessionId: string;
  type: GeofenceEventType;
  target: GeofenceTarget;
  /** Radar's external user id — our device id. Null if the payload had none. */
  userId: string | null;
  /** When the crossing happened (`actualCreatedAt`), not when Radar processed it. */
  capturedAt: Date;
  isOffline: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

function date(value: unknown): Date | null {
  const parsed = typeof value === "string" ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

/** A crossing of one of our session fences, or null for anything else. */
export function mapTrackingEvent(event: unknown, fallbackUser: unknown): TrackingRadarEvent | null {
  if (!isRecord(event)) return null;

  const id = str(event._id);
  const type = EVENT_TYPES[str(event.type) ?? ""];
  const createdAt = date(event.createdAt);
  const geofence = isRecord(event.geofence) ? event.geofence : null;
  const target = TRACKING_TAG_TARGET[str(geofence?.tag) ?? ""];
  const sessionId = str(geofence?.externalId);

  if (!id || !type || !createdAt || !target || !sessionId) return null;

  const capturedAt = date(event.actualCreatedAt) ?? createdAt;
  const user = isRecord(event.user) ? event.user : isRecord(fallbackUser) ? fallbackUser : null;

  return {
    id,
    sessionId,
    type,
    target,
    userId: str(user?.userId),
    capturedAt,
    isOffline: createdAt.getTime() - capturedAt.getTime() > REPLAYED_AFTER_MS,
  };
}

/**
 * The /tracking crossings in a Radar webhook body — `{ event, user }` or
 * `{ events, user }`. Everything else is left for the Radar POC's mapper.
 */
export function mapTrackingWebhook(body: unknown): TrackingRadarEvent[] {
  if (!isRecord(body)) return [];

  const raw = Array.isArray(body.events) ? body.events : body.event ? [body.event] : [];

  return raw.flatMap((item) => {
    const mapped = mapTrackingEvent(item, body.user);
    return mapped ? [mapped] : [];
  });
}
