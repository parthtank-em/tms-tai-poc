/**
 * The JSON shapes the Radar tracking API returns.
 *
 * Kept free of Prisma imports so the map and the simulator — both client
 * components — can share them with the route handlers without pulling the
 * database client into the browser bundle.
 */

export type RadarTripLifecycle = "ACTIVE" | "COMPLETED";

export const RADAR_TRIP_STATUSES = [
  "PENDING",
  "STARTED",
  "APPROACHING",
  "ARRIVED",
  "COMPLETED",
  "CANCELED",
  "EXPIRED",
] as const;

/** Radar's trip status, as last reported by Radar. */
export type RadarTripStatus = (typeof RADAR_TRIP_STATUSES)[number];

export type RadarGeofenceTarget = "START" | "DESTINATION";

/** A trip end and the radius of the Radar geofence around it. */
export type Geofence = {
  latitude: number;
  longitude: number;
  radiusMeters: number;
};

export type RadarEta = {
  minutes: number;
  distanceMeters: number | null;
};

export type RadarTripView = {
  id: string;
  deviceId: string;
  status: RadarTripLifecycle;
  /** Null until Radar has acknowledged the trip. */
  tripStatus: RadarTripStatus | null;
  startedAt: string;
  endedAt: string | null;
  start: Geofence;
  destination: Geofence;
  eta: RadarEta | null;
  /** When the status and ETA happened on the device, per Radar. */
  radarUpdatedAt: string | null;
  departedAt: string | null;
  arrivedAt: string | null;
  radarSyncError: string | null;
  locationCount: number;
  eventCount: number;
};

export type RadarLocationView = {
  id: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  capturedAt: string;
  receivedAt: string;
};

export type RadarEventView = {
  id: string;
  /** Radar's type verbatim, e.g. `user.entered_geofence`. */
  type: string;
  target: RadarGeofenceTarget | null;
  latitude: number | null;
  longitude: number | null;
  confidence: number | null;
  createdAt: string;
  actualCreatedAt: string;
  receivedAt: string;
};

/** One poll of the trip page. */
export type RadarFeed = {
  /** Fresh on every poll — status and ETA change without a new location. */
  trip: RadarTripView;
  /** Ordered by `capturedAt` ascending. */
  locations: RadarLocationView[];
  /** Ordered by `actualCreatedAt` ascending. */
  events: RadarEventView[];
  /**
   * Pass back as `?after=` on the next poll. Tracks arrival (`receivedAt`)
   * across both lists, so a late offline batch or a replayed event is still
   * picked up even though it carries an old timestamp.
   */
  cursor: string | null;
};

/** What a device sends for one position. */
export type LocationInput = {
  id: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  capturedAt: Date;
};
