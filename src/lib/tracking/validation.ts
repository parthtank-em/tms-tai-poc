import type { Geofence, LocationInput, RerouteInput, TrackingStatus, TripEnd } from "./types";

/**
 * Request-body parsing for the /tracking POC — the same rules as the Radar
 * POC's (src/lib/radar/validation.ts): the device endpoints and the
 * portal's session planner.
 *
 * A separate copy rather than an import, so either POC can change its contract
 * without touching the other. The error strings go
 * straight back to a mobile developer, so they name the field and the index.
 *
 * Client-safe (no Prisma), so the planner form checks the same rules before it
 * calls the server.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_ID_LENGTH = 100;
const MAX_DEVICE_ID_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 500;

/** A day offline at one fix a minute, with room to spare. */
export const MAX_BULK_LOCATIONS = 1_000;

/**
 * Below ~50 m GPS drift puts a parked device in and out of the fence; Radar
 * itself caps a circle at 10 km.
 */
export const MIN_GEOFENCE_RADIUS_METERS = 50;
export const MAX_GEOFENCE_RADIUS_METERS = 10_000;

/** Generous: Radar SDK accuracy is in meters and a poor fix can be kilometers out. */
const MAX_ACCURACY_METERS = 100_000;

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

// No "not in the future" check: a device with a skewed clock still produced a
// real fix, and rejecting it would lose it.
function timestamp(value: unknown): Date | null {
  const date = typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

export type StartSessionInput = {
  deviceId: string;
};

/**
 * The phone's Start: only who is driving. Where to and the fences were fixed
 * when the trip was planned on the portal.
 */
export function parseStartSession(body: unknown): Parsed<StartSessionInput> {
  const deviceId = isRecord(body) ? nonEmptyString(body.deviceId, MAX_DEVICE_ID_LENGTH) : null;

  if (!deviceId) {
    return {
      ok: false,
      error: `deviceId is required (a string of at most ${MAX_DEVICE_ID_LENGTH} characters).`,
    };
  }

  return { ok: true, value: { deviceId } };
}

export type PlanSessionInput = {
  start: TripEnd;
  destination: TripEnd;
};

/** A session as planned: two ends, each a point, a fence radius and an optional address. */
export function parsePlanSession(body: unknown): Parsed<PlanSessionInput> {
  const record = isRecord(body) ? body : {};

  const start = parseTripEnd(record.start, "start");
  if (!start.ok) return start;

  const destination = parseTripEnd(record.destination, "destination");
  if (!destination.ok) return destination;

  return { ok: true, value: { start: start.value, destination: destination.value } };
}

function parseTripEnd(value: unknown, label: string): Parsed<TripEnd> {
  const geofence = parseGeofence(value, label);
  if (!geofence.ok) return geofence;

  // Optional: a point entered as coordinates has no address.
  const raw = (value as Record<string, unknown>).address;
  let address: string | null = null;
  if (raw !== undefined && raw !== null && raw !== "") {
    address = nonEmptyString(raw, MAX_ADDRESS_LENGTH);
    if (address === null) {
      return {
        ok: false,
        error: `${label}.address must be a string of at most ${MAX_ADDRESS_LENGTH} characters.`,
      };
    }
  }

  return { ok: true, value: { ...geofence.value, address } };
}

const STATUSES: readonly TrackingStatus[] = ["PLANNED", "ACTIVE", "COMPLETED"];

/** `?status=` on the session list. Absent means every session. */
export function parseStatusFilter(value: string | null): Parsed<TrackingStatus | null> {
  if (value === null || value === "") return { ok: true, value: null };

  const status = STATUSES.find((candidate) => candidate === value.toUpperCase());
  return status
    ? { ok: true, value: status }
    : { ok: false, error: `status must be one of ${STATUSES.join(", ")}.` };
}

function parseGeofence(value: unknown, label: string): Parsed<Geofence> {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: `${label} is required — an object with latitude, longitude and radiusMeters.`,
    };
  }

  const latitude = coordinate(value.latitude, 90);
  if (latitude === null) {
    return { ok: false, error: `${label}.latitude must be a number between -90 and 90.` };
  }

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
  if (latitude === null) {
    return { ok: false, error: `${label}.latitude must be a number between -90 and 90.` };
  }

  const longitude = coordinate(body.longitude, 180);
  if (longitude === null) {
    return { ok: false, error: `${label}.longitude must be a number between -180 and 180.` };
  }

  const capturedAt = timestamp(body.capturedAt);
  if (!capturedAt) {
    return { ok: false, error: `${label}.capturedAt must be an ISO 8601 timestamp.` };
  }

  // Optional, but present-and-malformed is still an error so an app bug is heard.
  let accuracy: number | null = null;
  if (body.accuracy !== undefined && body.accuracy !== null) {
    if (
      typeof body.accuracy !== "number" ||
      !Number.isFinite(body.accuracy) ||
      body.accuracy < 0 ||
      body.accuracy > MAX_ACCURACY_METERS
    ) {
      return {
        ok: false,
        error: `${label}.accuracy must be a number of meters between 0 and ${MAX_ACCURACY_METERS}.`,
      };
    }
    accuracy = body.accuracy;
  }

  return { ok: true, value: { id, latitude, longitude, accuracy, capturedAt } };
}

/** All-or-nothing: one malformed point rejects the batch, so the queue stays intact. */
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

  for (const [index, item] of items.entries()) {
    const parsed = parseLocation(item, `locations[${index}]`);
    if (!parsed.ok) return parsed;
    locations.push(parsed.value);
  }

  return { ok: true, value: locations };
}

/** `?after=` on the feed endpoint. Absent means "everything". */
/**
 * The phone's reroute request: where it is now, and the route version it was
 * following (optional, but lets the server skip a request that is already
 * out of date).
 */
export function parseReroute(body: unknown): Parsed<RerouteInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "Body must be an object with latitude and longitude." };
  }

  const latitude = coordinate(body.latitude, 90);
  if (latitude === null) return { ok: false, error: "latitude must be a number between -90 and 90." };

  const longitude = coordinate(body.longitude, 180);
  if (longitude === null) return { ok: false, error: "longitude must be a number between -180 and 180." };

  let routeVersion: number | null = null;
  if (body.routeVersion !== undefined && body.routeVersion !== null) {
    if (typeof body.routeVersion !== "number" || !Number.isInteger(body.routeVersion) || body.routeVersion < 1) {
      return { ok: false, error: "routeVersion must be a whole number of at least 1." };
    }
    routeVersion = body.routeVersion;
  }

  return { ok: true, value: { latitude, longitude, routeVersion } };
}

export function parseAfter(value: string | null): Parsed<Date | null> {
  if (value === null || value === "") return { ok: true, value: null };

  const after = new Date(value);
  return Number.isNaN(after.getTime())
    ? { ok: false, error: "after must be an ISO 8601 timestamp." }
    : { ok: true, value: after };
}
