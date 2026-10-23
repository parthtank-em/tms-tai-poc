/**
 * The JSON shapes the tracking API returns.
 *
 * The same shapes as the Radar POC's (src/lib/radar/types.ts) — the two POCs
 * work the same way, except that /tracking plans its route with Google. Kept
 * free of Prisma imports so the map and the simulator — both client
 * components — can share them with the route handlers.
 */

/** PLANNED on the portal, ACTIVE from a phone's Start, COMPLETED at Stop. */
export type TrackingStatus = "PLANNED" | "ACTIVE" | "COMPLETED";

export const TRIP_STATUSES = [
  "PENDING",
  "STARTED",
  "APPROACHING",
  "ARRIVED",
  "COMPLETED",
  "CANCELED",
  "EXPIRED",
] as const;

/** Radar's status of the session's trip, as last reported by Radar. */
export type TripStatus = (typeof TRIP_STATUSES)[number];

export type GeofenceTarget = "START" | "DESTINATION";

export type Coordinates = { latitude: number; longitude: number };

/** A trip end and the radius of the Radar geofence around it. */
export type Geofence = Coordinates & {
  radiusMeters: number;
};

/** A trip end as planned: the fence, plus the address it was picked from. */
export type TripEnd = Geofence & {
  /** Null when the point was entered as coordinates. */
  address: string | null;
};

/** Radar's live ETA for the trip. */
export type TrackingEta = {
  minutes: number;
  distanceMeters: number | null;
};

/** Google's drive route between the two ends, from when the session was planned. */
export type PlannedRoute = {
  distanceMeters: number;
  durationMinutes: number;
};

/** A route preview: the planned figures plus the line to draw. */
export type RoutePreview = PlannedRoute & {
  /** `[longitude, latitude]` pairs, GeoJSON order. */
  path: [number, number][];
};

export type SessionView = {
  id: string;
  /** Null while PLANNED — no phone has started the session yet. */
  deviceId: string | null;
  status: TrackingStatus;
  /** Null until Radar has acknowledged the trip. */
  tripStatus: TripStatus | null;
  createdAt: string;
  /** Null while PLANNED. */
  startedAt: string | null;
  endedAt: string | null;
  start: TripEnd;
  destination: TripEnd;
  /** Google's route when planned. */
  planned: PlannedRoute | null;
  /** Radar's live ETA once the trip is active. */
  eta: TrackingEta | null;
  /** When the status and ETA happened on the device, per Radar. */
  radarUpdatedAt: string | null;
  departedAt: string | null;
  arrivedAt: string | null;
  radarSyncError: string | null;
  locationCount: number;
  eventCount: number;
  /** The route the driver should follow: 1 = planned, each reroute adds one. */
  routeVersion: number;
  /** When the driver was last rerouted, or null if never. */
  reroutedAt: string | null;
  /** The latest reroute's distance and time (Google, from where the driver left the route). */
  rerouted: PlannedRoute | null;
  /** The last Roads API failure snapping the driven line, or null. */
  drivenRouteError: string | null;
};

/** The route the driver should follow now, as the phone draws it. */
export type RouteView = {
  version: number;
  /** PLANNED for version 1; REROUTE after the driver left the route. */
  source: "PLANNED" | "REROUTE";
  distanceMeters: number;
  durationMinutes: number;
  /** Google encoded polyline (precision 5) — draw it with the Maps SDK. */
  polyline: string;
  /** When this route was made: planning time, or the reroute time. */
  updatedAt: string;
};

export type LocationView = {
  id: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  capturedAt: string;
  receivedAt: string;
};

export type EventView = {
  id: string;
  /** Radar's type verbatim, e.g. `user.entered_geofence`. */
  type: string;
  target: GeofenceTarget | null;
  latitude: number | null;
  longitude: number | null;
  confidence: number | null;
  createdAt: string;
  actualCreatedAt: string;
  receivedAt: string;
};

/** One poll of the session page. */
export type SessionFeed = {
  /** Fresh on every poll — status and ETA change without a new location. */
  session: SessionView;
  /**
   * The planned route's line, `[longitude, latitude]` pairs. Only on the first
   * load (no `after`): it never changes, so polls do not resend it.
   */
  plannedPath: [number, number][] | null;
  /**
   * The latest reroute's line. Sent on the first load and whenever the driver
   * has been rerouted since `after`; otherwise null (keep the one you have).
   */
  currentPath: [number, number][] | null;
  /**
   * The driven points snapped to roads. Sent on the first load and whenever it
   * was refreshed since `after`; otherwise null (keep the one you have).
   */
  drivenPath: [number, number][] | null;
  /** Ordered by `capturedAt` ascending. */
  locations: LocationView[];
  /** Ordered by `actualCreatedAt` ascending. */
  events: EventView[];
  /**
   * Pass back as `?after=` on the next poll. Tracks arrival (`receivedAt`)
   * across both lists, so a late offline batch or a replayed event is still
   * picked up even though it carries an old timestamp.
   */
  cursor: string | null;
};

/** What a device sends when it finds itself off the route. */
export type RerouteInput = Coordinates & {
  /** The route version the phone was following, so a stale request is not rerouted twice. */
  routeVersion: number | null;
};

/** What a device sends for one position. */
export type LocationInput = {
  id: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  capturedAt: Date;
};
