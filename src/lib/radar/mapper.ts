import { DESTINATION_GEOFENCE_TAG, START_GEOFENCE_TAG } from "./config";
import { RADAR_TRIP_STATUSES, type RadarGeofenceTarget, type RadarTripStatus } from "./types";

/**
 * Turns a Radar webhook body into the rows this POC stores.
 *
 * Radar sends either `{ event, user }` (Single Event delivery) or
 * `{ events, user }` (Multiple Events, batches of up to five). Both are
 * accepted. Pure — no database — so it is tested on its own.
 *
 * An event belongs to a trip when either
 * - it is a geofence event for one of our two tags: the fence's `externalId`
 *   is the trip id, and the tag says which end; or
 * - it carries a `trip` whose `externalId` is the trip id.
 *
 * Anything else (places, regions, other projects' fences) is counted and
 * dropped.
 */

export type TripSnapshot = {
  status: RadarTripStatus | null;
  etaMinutes: number | null;
  etaDistanceMeters: number | null;
};

export type MappedEvent = {
  id: string;
  tripId: string;
  type: string;
  target: RadarGeofenceTarget | null;
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

export type MappedWebhook = { events: MappedEvent[]; ignored: number };

const TAG_TARGET: Record<string, RadarGeofenceTarget> = {
  [START_GEOFENCE_TAG]: "START",
  [DESTINATION_GEOFENCE_TAG]: "DESTINATION",
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
function tripStatus(value: unknown): RadarTripStatus | null {
  const upper = typeof value === "string" ? value.toUpperCase() : null;
  return RADAR_TRIP_STATUSES.find((status) => status === upper) ?? null;
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

/** The trip and fence an event belongs to, or null if it is not ours. */
function ownership(event: Record<string, unknown>) {
  const geofence = isRecord(event.geofence) ? event.geofence : null;
  const tag = str(geofence?.tag);
  const target = tag ? TAG_TARGET[tag] : undefined;
  const fenceTripId = target ? str(geofence?.externalId) : null;

  if (target && fenceTripId) return { tripId: fenceTripId, target };

  const tripId = isRecord(event.trip) ? str(event.trip.externalId) : null;
  return tripId ? { tripId, target: null } : null;
}

export function mapEvent(event: unknown, fallbackUser: unknown): MappedEvent | null {
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
    tripId: owner.tripId,
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

export function mapWebhook(body: unknown): MappedWebhook | null {
  if (!isRecord(body)) return null;

  const raw = Array.isArray(body.events) ? body.events : body.event ? [body.event] : null;
  if (!raw) return null;

  const events: MappedEvent[] = [];
  for (const item of raw) {
    const mapped = mapEvent(item, body.user);
    if (mapped) events.push(mapped);
  }

  return { events, ignored: raw.length - events.length };
}

/** What one webhook delivery changes on one trip. */
export type TripUpdate = {
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
function newestTripState(current: TripUpdate["latest"], trip: TripSnapshot, at: Date): TripUpdate["latest"] {
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
 * Folds a delivery's events into one update per trip. The caller applies each
 * with "newest wins" for `latest` and "earliest wins" for the two timestamps,
 * against what the database already holds — so the order deliveries arrive in
 * does not matter.
 */
export function tripUpdates(events: MappedEvent[]): Map<string, TripUpdate> {
  const updates = new Map<string, TripUpdate>();

  for (const event of events) {
    const update = updates.get(event.tripId) ?? { latest: null, departedAt: null, arrivedAt: null };

    if (event.trip) update.latest = newestTripState(update.latest, event.trip, event.actualCreatedAt);

    if (event.type === "user.exited_geofence" && event.target === "START") {
      update.departedAt = earliest(update.departedAt, event.actualCreatedAt);
    }

    if (event.type === "user.arrived_at_trip_destination") {
      update.arrivedAt = earliest(update.arrivedAt, event.actualCreatedAt);
    }

    updates.set(event.tripId, update);
  }

  return updates;
}
