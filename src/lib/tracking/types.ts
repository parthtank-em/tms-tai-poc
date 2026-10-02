/**
 * The JSON shapes the tracking API returns.
 *
 * Kept free of Prisma imports so the map and the simulator — both client
 * components — can share them with the route handlers without pulling the
 * database client into the browser bundle.
 */

export type TrackingStatus = "ACTIVE" | "COMPLETED";

/**
 * A trip end — the start or the destination — and the geofence circle around
 * it. Set when the session is created; the server only stores and draws it.
 */
export type Geofence = {
  latitude: number;
  longitude: number;
  radiusMeters: number;
};

export type SessionView = {
  id: string;
  deviceId: string;
  startedAt: string;
  endedAt: string | null;
  status: TrackingStatus;
  locationCount: number;
  /**
   * Required on every new session. Null only on sessions created before trips
   * had a start and a destination.
   */
  start: Geofence | null;
  destination: Geofence | null;
  /** The phone's planned trip distance at Start. */
  distanceMeters: number | null;
  /** The phone's ETA at Start. Later updates ride on each location. */
  eta: string | null;
};

export type GeofenceEventType = "ENTER" | "EXIT";

/** Which of the session's two fences a crossing was against. */
export type GeofenceTarget = "START" | "DESTINATION";

export type GeofenceEventView = {
  id: string;
  type: GeofenceEventType;
  target: GeofenceTarget;
  capturedAt: string;
  receivedAt: string;
  isOffline: boolean;
};

export type LocationView = {
  id: string;
  latitude: number;
  longitude: number;
  capturedAt: string;
  receivedAt: string;
  /** The phone's remaining distance and ETA at this fix, when it had them. */
  remainingDistanceMeters: number | null;
  eta: string | null;
};

export type LocationsResponse = {
  sessionId: string;
  status: TrackingStatus;
  /** Ordered by `capturedAt` ascending. */
  locations: LocationView[];
  /** Newest `capturedAt` in this response, or null when it is empty. */
  latestCapturedAt: string | null;
  /** Ordered by `capturedAt` ascending, filtered by the same `after`. */
  geofenceEvents: GeofenceEventView[];
  /**
   * Pass back as `?after=` on the next poll. It tracks `receivedAt`, not
   * `capturedAt` — see `listLocations` in ./service.ts for why — across both
   * locations and geofence events.
   */
  cursor: string | null;
};

/** What a device sends for one position. */
export type LocationInput = {
  id: string;
  latitude: number;
  longitude: number;
  capturedAt: Date;
  remainingDistanceMeters: number | null;
  eta: Date | null;
};

/** What a device sends for one geofence crossing. */
export type GeofenceEventInput = {
  id: string;
  type: GeofenceEventType;
  target: GeofenceTarget;
  capturedAt: Date;
  isOffline: boolean;
};
