import type { GeofenceEventView, LocationView } from "./types";

/**
 * Folds a poll's worth of locations into what the map already has.
 *
 * Polls overlap by design (the cursor is inclusive), so incoming ids that are
 * already present are dropped. The result is re-sorted by capture time because
 * an offline batch lands late with old timestamps and belongs in the middle of
 * the route, not tacked onto its end.
 */
export function mergeLocations(current: LocationView[], incoming: LocationView[]): LocationView[] {
  return mergeByCapture(current, incoming);
}

/** The same fold for geofence events: a late offline EXIT lands in its place. */
export function mergeGeofenceEvents(
  current: GeofenceEventView[],
  incoming: GeofenceEventView[],
): GeofenceEventView[] {
  return mergeByCapture(current, incoming);
}

function mergeByCapture<T extends { id: string; capturedAt: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map((item) => item.id));
  const fresh = incoming.filter((item) => !seen.has(item.id));

  if (fresh.length === 0) return current;

  return [...current, ...fresh].sort(
    (a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id),
  );
}

/**
 * How long after capture a point reached the server before we call it an
 * offline upload rather than a live send. A live send on mobile data can take
 * a few seconds; anything past a minute was queued.
 */
const LATE_AFTER_MS = 60_000;

export function arrivedLate(location: LocationView): boolean {
  return Date.parse(location.receivedAt) - Date.parse(location.capturedAt) > LATE_AFTER_MS;
}
