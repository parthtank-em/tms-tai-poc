/**
 * The JSON shapes the tracking API returns.
 *
 * Kept free of Prisma imports so the map and the simulator — both client
 * components — can share them with the route handlers without pulling the
 * database client into the browser bundle.
 */

export type TrackingStatus = "ACTIVE" | "COMPLETED";

/** A circle set when the session is created. Used for drawing only. */
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
  geofence: Geofence | null;
};

export type GeofenceEventType = "ENTER" | "EXIT";

export type GeofenceEventView = {
  id: string;
  type: GeofenceEventType;
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
};

/** What a device sends for one geofence crossing. */
export type GeofenceEventInput = {
  id: string;
  type: GeofenceEventType;
  capturedAt: Date;
  isOffline: boolean;
};
