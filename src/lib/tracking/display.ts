import type {
  EventView,
  GeofenceTarget,
  LocationView,
  SessionView,
  TripEnd,
  WeatherAlertView,
} from "./types";

/**
 * Pure helpers for the /tracking session pages — a copy of the Radar POC's
 * (src/lib/radar/display.ts). Client-safe: no Prisma, no secrets.
 */

/**
 * Folds a poll into what the page already has. Polls overlap by design (the
 * cursor is inclusive), so known ids are dropped; the result is re-sorted
 * because a late offline batch or a replayed event belongs in the middle.
 */
export function mergeLocations(
  current: LocationView[],
  incoming: LocationView[],
): LocationView[] {
  return mergeSorted(current, incoming, (item) => item.capturedAt);
}

export function mergeEvents(current: EventView[], incoming: EventView[]): EventView[] {
  return mergeSorted(current, incoming, (item) => item.actualCreatedAt);
}

export function mergeWeatherAlerts(
  current: WeatherAlertView[],
  incoming: WeatherAlertView[],
): WeatherAlertView[] {
  return mergeSorted(current, incoming, (item) => item.expectedAt);
}

function mergeSorted<T extends { id: string }>(current: T[], incoming: T[], at: (item: T) => string): T[] {
  const seen = new Set(current.map((item) => item.id));
  const fresh = incoming.filter((item) => !seen.has(item.id));

  if (fresh.length === 0) return current;

  return [...current, ...fresh].sort((a, b) => at(a).localeCompare(at(b)) || a.id.localeCompare(b.id));
}

/**
 * How far behind Radar processed an event before we call it replayed rather
 * than live. A live event is processed within seconds of the fix.
 */
const REPLAYED_AFTER_MS = 60_000;

export function wasReplayed(event: EventView): boolean {
  return Date.parse(event.createdAt) - Date.parse(event.actualCreatedAt) > REPLAYED_AFTER_MS;
}

const TARGET_LABEL: Record<GeofenceTarget, string> = { START: "start", DESTINATION: "destination" };

/** `user.exited_geofence` + START → "Exited start geofence". */
export function eventLabel(event: Pick<EventView, "type" | "target">): string {
  const fence = event.target ? `${TARGET_LABEL[event.target]} geofence` : "geofence";

  switch (event.type) {
    case "user.entered_geofence":
      return `Entered ${fence}`;
    case "user.exited_geofence":
      return `Exited ${fence}`;
    case "user.dwelled_in_geofence":
      return `Dwelled in ${fence}`;
    case "user.started_trip":
      return "Trip started";
    case "user.updated_trip":
      return "Trip updated";
    case "user.approaching_trip_destination":
      return "Approaching destination";
    case "user.arrived_at_trip_destination":
      return "Arrived at destination";
    case "user.stopped_trip":
      return "Trip stopped";
    case "user.arrived_at_wrong_trip_destination":
      return "Arrived at wrong destination";
    default:
      return event.type;
  }
}

/** Milestones worth a pin on the map; ETA refreshes are only listed. */
export function isMilestone(event: EventView): boolean {
  return event.type !== "user.updated_trip";
}

/** When Radar expects arrival: the ETA's minutes counted from the event that reported them. */
export function arrivalTime(trip: Pick<SessionView, "eta" | "radarUpdatedAt">): Date | null {
  if (!trip.eta || !trip.radarUpdatedAt) return null;
  return new Date(Date.parse(trip.radarUpdatedAt) + trip.eta.minutes * 60_000);
}

/** A trip end by its address, or by its coordinates when it was entered as such. */
export function endLabel(end: TripEnd): string {
  return end.address ?? `${end.latitude.toFixed(5)}, ${end.longitude.toFixed(5)}`;
}

/** `112400` → `112.4 km`, `850` → `850 m`. */
export function formatDistance(meters: number | null | undefined): string {
  if (meters === null || meters === undefined) return "—";
  if (meters < 1_000) return `${meters} m`;

  return `${(meters / 1_000).toLocaleString("en-US", { maximumFractionDigits: 1 })} km`;
}

/** `14.5` → `15 min`, `95` → `1 h 35 min`. */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";

  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;

  return `${Math.floor(rounded / 60)} h ${rounded % 60} min`;
}
