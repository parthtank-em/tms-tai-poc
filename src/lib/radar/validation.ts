import type { Geofence, LocationInput } from "./types";

/**
 * Request-body parsing for the Radar POC's device endpoints.
 *
 * A separate copy of the /tracking rules rather than an import, so either POC
 * can change its contract without touching the other. The error strings go
 * straight back to a mobile developer, so they name the field and the index.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_ID_LENGTH = 100;
const MAX_DEVICE_ID_LENGTH = 200;

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

export type StartTripInput = {
  deviceId: string;
  start: Geofence;
  destination: Geofence;
};

/** No distance or ETA here, unlike /tracking: Radar computes both. */
export function parseStartTrip(body: unknown): Parsed<StartTripInput> {
  const deviceId = isRecord(body) ? nonEmptyString(body.deviceId, MAX_DEVICE_ID_LENGTH) : null;

  if (!deviceId) {
    return {
      ok: false,
      error: `deviceId is required (a string of at most ${MAX_DEVICE_ID_LENGTH} characters).`,
    };
  }

  const record = body as Record<string, unknown>;

  const start = parseGeofence(record.start, "start");
  if (!start.ok) return start;

  const destination = parseGeofence(record.destination, "destination");
  if (!destination.ok) return destination;

  return { ok: true, value: { deviceId, start: start.value, destination: destination.value } };
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
export function parseAfter(value: string | null): Parsed<Date | null> {
  if (value === null || value === "") return { ok: true, value: null };

  const after = new Date(value);
  return Number.isNaN(after.getTime())
    ? { ok: false, error: "after must be an ISO 8601 timestamp." }
    : { ok: true, value: after };
}
