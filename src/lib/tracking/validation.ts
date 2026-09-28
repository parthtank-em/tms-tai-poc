import type { LocationInput } from "./types";

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

export function parseStartSession(body: unknown): Parsed<{ deviceId: string }> {
  const deviceId = isRecord(body) ? nonEmptyString(body.deviceId, MAX_DEVICE_ID_LENGTH) : null;

  return deviceId
    ? { ok: true, value: { deviceId } }
    : { ok: false, error: `deviceId is required (a string of at most ${MAX_DEVICE_ID_LENGTH} characters).` };
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

  // Deliberately no "not in the future" check: a device with a skewed clock
  // still produced a real fix, and rejecting it would lose the point outright.
  const capturedAt = typeof body.capturedAt === "string" ? new Date(body.capturedAt) : null;
  if (!capturedAt || Number.isNaN(capturedAt.getTime())) {
    return { ok: false, error: `${label}.capturedAt must be an ISO 8601 timestamp.` };
  }

  return { ok: true, value: { id, latitude, longitude, capturedAt } };
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
