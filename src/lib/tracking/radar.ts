import type { GeofenceKey } from "@/lib/radar/client";

import { TRIP_STATUSES, type GeofenceTarget, type TripStatus } from "./types";

/**
 * Radar for the /tracking POC: the same use as the Radar POC — two fences and
 * a Radar trip per session, created at Start — under its own tags, so the
 * shared webhook can tell the two POCs' events apart.
 *
 * The webhook mapping below is a copy of the Radar POC's
 * (src/lib/radar/mapper.ts) with /tracking's tags and trip ids. Pure — no
 * database — so the simulator can share the tags and the mapping is tested on
 * its own.
 */

/** Tags of a session's two fences; the fence `externalId` is the session id. */
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

/**
 * The Radar trip's `externalId`. Prefixed, unlike the Radar POC's (a bare trip
 * id), so a trip event — which carries no fence tag — is still recognisably
 * /tracking's.
 */
const TRIP_EXTERNAL_ID_PREFIX = "tms-track-";

export function sessionTripExternalId(sessionId: string): string {
  return `${TRIP_EXTERNAL_ID_PREFIX}${sessionId}`;
}

export type TripSnapshot = {
  status: TripStatus | null;
  etaMinutes: number | null;
  etaDistanceMeters: number | null;
};

/** One Radar event that belongs to a session, in the shape `tracking_events` stores. */
export type MappedTrackingEvent = {
  id: string;
  sessionId: string;
  type: string;
  target: GeofenceTarget | null;
  /** Radar's external user id — our device id. Null if the payload had none. */
  userId: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  confidence: number | null;
  createdAt: Date;
  actualCreatedAt: Date;
  /** The trip as Radar saw it at this event, when the event carried one. */
  trip: TripSnapshot | null;
  payload: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function date(value: unknown): Date | null {
  const parsed = typeof value === "string" ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

/** Radar's lower-case status, if it is one we model. */
function tripStatus(value: unknown): TripStatus | null {
  const upper = typeof value === "string" ? value.toUpperCase() : null;
  return TRIP_STATUSES.find((status) => status === upper) ?? null;
}

function tripSnapshot(value: unknown): TripSnapshot | null {
  if (!isRecord(value)) return null;

  const eta = isRecord(value.eta) ? value.eta : null;
  const distance = num(eta?.distance);

  return {
    status: tripStatus(value.status),
    etaMinutes: num(eta?.duration),
    etaDistanceMeters: distance === null ? null : Math.round(distance),
  };
}

/**
 * The session and fence an event belongs to, or null if it is not /tracking's:
 * a geofence event on one of our tags (the fence's `externalId` is the
 * session id), or any event carrying a trip whose `externalId` is ours.
 */
function ownership(event: Record<string, unknown>) {
  const geofence = isRecord(event.geofence) ? event.geofence : null;
  const target = TRACKING_TAG_TARGET[str(geofence?.tag) ?? ""];
  const fenceSessionId = target ? str(geofence?.externalId) : null;

  if (target && fenceSessionId) return { sessionId: fenceSessionId, target };

  const externalId = isRecord(event.trip) ? str(event.trip.externalId) : null;
  if (!externalId?.startsWith(TRIP_EXTERNAL_ID_PREFIX)) return null;

  return { sessionId: externalId.slice(TRIP_EXTERNAL_ID_PREFIX.length), target: null };
}

export function mapTrackingEvent(event: unknown, fallbackUser: unknown): MappedTrackingEvent | null {
  if (!isRecord(event)) return null;

  const id = str(event._id);
  const type = str(event.type);
  const createdAt = date(event.createdAt);
  const owner = ownership(event);

  if (!id || !type || !createdAt || !owner) return null;

  const user = isRecord(event.user) ? event.user : isRecord(fallbackUser) ? fallbackUser : null;

  // GeoJSON order: [longitude, latitude].
  const location = isRecord(event.location) ? event.location : null;
  const coordinates = Array.isArray(location?.coordinates) ? location.coordinates : [];
  const longitude = num(coordinates[0]);
  const latitude = num(coordinates[1]);
  const hasPoint = latitude !== null && longitude !== null;

  return {
    id,
    sessionId: owner.sessionId,
    type,
    target: owner.target,
    userId: str(user?.userId),
    latitude: hasPoint ? latitude : null,
    longitude: hasPoint ? longitude : null,
    accuracy: num(event.locationAccuracy),
    confidence: num(event.confidence),
    createdAt,
    actualCreatedAt: date(event.actualCreatedAt) ?? createdAt,
    trip: tripSnapshot(event.trip),
    payload: event,
  };
}

/**
 * The /tracking events in a Radar webhook body — `{ event, user }` or
 * `{ events, user }`. Everything else is left for the Radar POC's mapper.
 */
export function mapTrackingWebhook(body: unknown): MappedTrackingEvent[] {
  if (!isRecord(body)) return [];

  const raw = Array.isArray(body.events) ? body.events : body.event ? [body.event] : [];

  return raw.flatMap((item) => {
    const mapped = mapTrackingEvent(item, body.user);
    return mapped ? [mapped] : [];
  });
}

/** What one webhook delivery changes on one session. */
export type SessionUpdate = {
  /** The newest event that carried trip state, with its `actualCreatedAt`. */
  latest: (TripSnapshot & { at: Date }) | null;
  /** Earliest exit from the start fence in this delivery. */
  departedAt: Date | null;
  /** Earliest arrival at the destination in this delivery. */
  arrivedAt: Date | null;
};

const earliest = (a: Date | null, b: Date) => (a === null || b < a ? b : a);

/**
 * The newest trip state of a delivery. Its ETA is the newest one that has an
 * ETA: an arrival carries none, and an approach just before it in the same
 * delivery must not lose its ETA for that.
 */
function newestTripState(
  current: SessionUpdate["latest"],
  trip: TripSnapshot,
  at: Date,
): SessionUpdate["latest"] {
  if (!current || at > current.at) {
    const keepEta = current && trip.etaMinutes === null;
    return keepEta
      ? { ...trip, at, etaMinutes: current.etaMinutes, etaDistanceMeters: current.etaDistanceMeters }
      : { ...trip, at };
  }

  // An older event only fills in an ETA the newer one lacks.
  return current.etaMinutes === null && trip.etaMinutes !== null
    ? { ...current, etaMinutes: trip.etaMinutes, etaDistanceMeters: trip.etaDistanceMeters }
    : current;
}

/**
 * Folds a delivery's events into one update per session. The caller applies
 * each with "newest wins" for `latest` and "earliest wins" for the two
 * timestamps, against what the database already holds — so the order
 * deliveries arrive in does not matter.
 */
export function sessionUpdates(events: MappedTrackingEvent[]): Map<string, SessionUpdate> {
  const updates = new Map<string, SessionUpdate>();

  for (const event of events) {
    const update = updates.get(event.sessionId) ?? { latest: null, departedAt: null, arrivedAt: null };

    if (event.trip) update.latest = newestTripState(update.latest, event.trip, event.actualCreatedAt);

    if (event.type === "user.exited_geofence" && event.target === "START") {
      update.departedAt = earliest(update.departedAt, event.actualCreatedAt);
    }

    if (event.type === "user.arrived_at_trip_destination") {
      update.arrivedAt = earliest(update.arrivedAt, event.actualCreatedAt);
    }

    updates.set(event.sessionId, update);
  }

  return updates;
}
