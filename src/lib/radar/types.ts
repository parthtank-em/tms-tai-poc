/**
 * The JSON shapes the Radar tracking API returns.
 *
 * Kept free of Prisma imports so the map and the simulator — both client
 * components — can share them with the route handlers without pulling the
 * database client into the browser bundle.
 */

export type RadarTripLifecycle = "PLANNED" | "ACTIVE" | "COMPLETED";

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

export type Coordinates = { latitude: number; longitude: number };

/** A trip end and the radius of the Radar geofence around it. */
export type Geofence = Coordinates & {
  radiusMeters: number;
};

/** A trip end as planned on the portal: the fence, plus the address it was picked from. */
export type TripEnd = Geofence & {
  /** Null when the point was entered as coordinates. */
  address: string | null;
};

export type RadarEta = {
  minutes: number;
  distanceMeters: number | null;
};

/** Radar's car route between the two ends, from when the trip was planned. */
export type PlannedRoute = {
  distanceMeters: number;
  durationMinutes: number;
};

export type RadarTripView = {
  id: string;
  /** Null while PLANNED — no phone has started the trip yet. */
  deviceId: string | null;
  status: RadarTripLifecycle;
  /** Null until Radar has acknowledged the trip. */
  tripStatus: RadarTripStatus | null;
  createdAt: string;
  /** Null while PLANNED. */
  startedAt: string | null;
  endedAt: string | null;
  start: TripEnd;
  destination: TripEnd;
  /** Null for trips from before the portal planned them. */
  planned: PlannedRoute | null;
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
  /**
   * The planned route's line, `[longitude, latitude]` pairs. Only on the first
   * load (no `after`): it never changes, so polls do not resend it.
   */
  plannedPath: [number, number][] | null;
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

/** A route preview: the planned figures plus the line to draw. */
export type RoutePreview = PlannedRoute & {
  /** `[longitude, latitude]` pairs, GeoJSON order. */
  path: [number, number][];
};

/** What a device sends for one position. */
export type LocationInput = {
  id: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  capturedAt: Date;
};
