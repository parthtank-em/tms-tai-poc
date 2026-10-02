import type { Geofence, GeofenceEventInput, LocationInput } from "./types";

/**
 * Request-body parsing for the mobile endpoints.
 *
 * Hand-rolled rather than a schema library: the bodies are three or four flat
 * fields, and the error strings go straight back to a mobile developer, so
 * they should name the field and the index rather than a generic path.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_ID_LENGTH = 100;
const MAX_DEVICE_ID_LENGTH = 200;

/**
 * Upper bound on one bulk upload. A device offline for a full day at one fix
 * every two minutes queues ~720 points, so this covers that with room to spare
 * while still refusing a runaway client.
 */
export const MAX_BULK_LOCATIONS = 1_000;

/** Per request. A day offline produces a handful of crossings, not thousands. */
export const MAX_BULK_GEOFENCE_EVENTS = 1_000;

/**
 * Below ~50 m ordinary GPS drift puts a parked device in and out of the fence;
 * the upper bound only refuses obvious unit mistakes (km sent as m).
 */
export const MIN_GEOFENCE_RADIUS_METERS = 50;
export const MAX_GEOFENCE_RADIUS_METERS = 100_000;

const GEOFENCE_EVENT_TYPES = ["ENTER", "EXIT"] as const;
const GEOFENCE_TARGETS = ["START", "DESTINATION"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function coordinate(value: unknown, limit: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit
    ? value
    : null;
}

// Deliberately no "not in the future" check: a device with a skewed clock
// still produced a real fix or crossing, and rejecting it would lose it.
function timestamp(value: unknown): Date | null {
  const date = typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/** Roughly half the planet's circumference — refuses only obvious unit mistakes. */
export const MAX_DISTANCE_METERS = 20_000_000;

function distance(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_DISTANCE_METERS
    ? value
    : null;
}

const distanceError = (field: string) =>
  `${field} must be a whole number of meters between 0 and ${MAX_DISTANCE_METERS}.`;

export type StartSessionInput = {
  deviceId: string;
  start: Geofence;
  destination: Geofence;
  distanceMeters: number;
  eta: Date;
};

/**
 * Distance and ETA come from the phone, not the server: for the POC the device
 * already has a route, and the server only stores and shows what it reports.
 */
export function parseStartSession(body: unknown): Parsed<StartSessionInput> {
  const deviceId = isRecord(body) ? nonEmptyString(body.deviceId, MAX_DEVICE_ID_LENGTH) : null;

  if (!deviceId) {
    return { ok: false, error: `deviceId is required (a string of at most ${MAX_DEVICE_ID_LENGTH} characters).` };
  }

  const record = body as Record<string, unknown>;

  const start = parseGeofence(record.start, "start");
  if (!start.ok) return start;

  const destination = parseGeofence(record.destination, "destination");
  if (!destination.ok) return destination;

  const distanceMeters = distance(record.distanceMeters);
  if (distanceMeters === null) return { ok: false, error: distanceError("distanceMeters") };

  const eta = timestamp(record.eta);
  if (!eta) return { ok: false, error: "eta must be an ISO 8601 timestamp." };

  return {
    ok: true,
    value: { deviceId, start: start.value, destination: destination.value, distanceMeters, eta },
  };
}

/** A trip end: a point and the radius of the geofence the device registers around it. */
function parseGeofence(value: unknown, label: string): Parsed<Geofence> {
  if (!isRecord(value)) {
    return { ok: false, error: `${label} is required — an object with latitude, longitude and radiusMeters.` };
  }

  const latitude = coordinate(value.latitude, 90);
  if (latitude === null) return { ok: false, error: `${label}.latitude must be a number between -90 and 90.` };

  const longitude = coordinate(value.longitude, 180);
  if (longitude === null) {
    return { ok: false, error: `${label}.longitude must be a number between -180 and 180.` };
  }

  const radiusMeters = value.radiusMeters;
  if (
    typeof radiusMeters !== "number" ||
    !Number.isInteger(radiusMeters) ||
    radiusMeters < MIN_GEOFENCE_RADIUS_METERS ||
    radiusMeters > MAX_GEOFENCE_RADIUS_METERS
  ) {
    return {
      ok: false,
      error: `${label}.radiusMeters must be a whole number between ${MIN_GEOFENCE_RADIUS_METERS} and ${MAX_GEOFENCE_RADIUS_METERS}.`,
    };
  }

  return { ok: true, value: { latitude, longitude, radiusMeters } };
}

export function parseLocation(body: unknown, label = "location"): Parsed<LocationInput> {
  if (!isRecord(body)) return { ok: false, error: `${label} must be an object.` };

  const id = nonEmptyString(body.id, MAX_ID_LENGTH);
  if (!id) {
    return {
      ok: false,
      error: `${label}.id is required — a device-generated id (UUID) of at most ${MAX_ID_LENGTH} characters.`,
    };
  }

  const latitude = coordinate(body.latitude, 90);
  if (latitude === null) return { ok: false, error: `${label}.latitude must be a number between -90 and 90.` };

  const longitude = coordinate(body.longitude, 180);
  if (longitude === null) {
    return { ok: false, error: `${label}.longitude must be a number between -180 and 180.` };
  }

  const capturedAt = timestamp(body.capturedAt);
  if (!capturedAt) return { ok: false, error: `${label}.capturedAt must be an ISO 8601 timestamp.` };

  // Optional: a phone without a route yet (no GPS lock, say) still has a fix
  // worth keeping. Present but malformed is still an error, so a bug in the
  // app is heard rather than silently stored as "unknown".
  let remainingDistanceMeters: number | null = null;
  if (body.remainingDistanceMeters !== undefined && body.remainingDistanceMeters !== null) {
    remainingDistanceMeters = distance(body.remainingDistanceMeters);
    if (remainingDistanceMeters === null) {
      return { ok: false, error: distanceError(`${label}.remainingDistanceMeters`) };
    }
  }

  let eta: Date | null = null;
  if (body.eta !== undefined && body.eta !== null) {
    eta = timestamp(body.eta);
    if (!eta) return { ok: false, error: `${label}.eta must be an ISO 8601 timestamp.` };
  }

  return { ok: true, value: { id, latitude, longitude, capturedAt, remainingDistanceMeters, eta } };
}

function parseGeofenceEvent(body: unknown, label: string): Parsed<GeofenceEventInput> {
  if (!isRecord(body)) return { ok: false, error: `${label} must be an object.` };

  const id = nonEmptyString(body.id, MAX_ID_LENGTH);
  if (!id) {
    return {
      ok: false,
      error: `${label}.id is required — a device-generated id (UUID) of at most ${MAX_ID_LENGTH} characters.`,
    };
  }

  const type = GEOFENCE_EVENT_TYPES.find((candidate) => candidate === body.type);
  if (!type) return { ok: false, error: `${label}.type must be "ENTER" or "EXIT".` };

  const target = GEOFENCE_TARGETS.find((candidate) => candidate === body.target);
  if (!target) return { ok: false, error: `${label}.target must be "START" or "DESTINATION".` };

  const capturedAt = timestamp(body.capturedAt);
  if (!capturedAt) return { ok: false, error: `${label}.capturedAt must be an ISO 8601 timestamp.` };

  // Required rather than defaulted: a client that forgets it should hear so,
  // not have its offline events silently recorded as live.
  if (typeof body.isOffline !== "boolean") {
    return { ok: false, error: `${label}.isOffline must be true or false.` };
  }

  return { ok: true, value: { id, type, target, capturedAt, isOffline: body.isOffline } };
}

/**
 * One endpoint for live and offline sends alike — a live crossing is a batch
 * of one. All-or-nothing for the same reason as `parseBulkLocations`.
 */
export function parseGeofenceEvents(body: unknown): Parsed<GeofenceEventInput[]> {
  const items = isRecord(body) ? body.events : undefined;

  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: "events must be a non-empty array." };
  }

  if (items.length > MAX_BULK_GEOFENCE_EVENTS) {
    return {
      ok: false,
      error: `At most ${MAX_BULK_GEOFENCE_EVENTS} events per request — split the queue into batches.`,
    };
  }

  const events: GeofenceEventInput[] = [];

  for (const [index, item] of items.entries()) {
    const parsed = parseGeofenceEvent(item, `events[${index}]`);
    if (!parsed.ok) return parsed;
    events.push(parsed.value);
  }

  return { ok: true, value: events };
}

export function parseBulkLocations(body: unknown): Parsed<LocationInput[]> {
  const items = isRecord(body) ? body.locations : undefined;

  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: "locations must be a non-empty array." };
  }

  if (items.length > MAX_BULK_LOCATIONS) {
    return {
      ok: false,
      error: `At most ${MAX_BULK_LOCATIONS} locations per request — split the queue into batches.`,
    };
  }

  const locations: LocationInput[] = [];

  // All-or-nothing: one malformed point rejects the batch. The device keeps its
  // queue until a request succeeds, so a partial accept would leave it unable
  // to tell which points still need sending.
  for (const [index, item] of items.entries()) {
    const parsed = parseLocation(item, `locations[${index}]`);
    if (!parsed.ok) return parsed;
    locations.push(parsed.value);
  }

  return { ok: true, value: locations };
}

/** `?after=` on the locations endpoint. Absent means "everything". */
export function parseAfter(value: string | null): Parsed<Date | null> {
  if (value === null || value === "") return { ok: true, value: null };

  const after = new Date(value);
  return Number.isNaN(after.getTime())
    ? { ok: false, error: "after must be an ISO 8601 timestamp." }
    : { ok: true, value: after };
}
