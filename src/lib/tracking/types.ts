/**
 * The JSON shapes the tracking API returns.
 *
 * Kept free of Prisma imports so the map and the simulator — both client
 * components — can share them with the route handlers without pulling the
 * database client into the browser bundle.
 */

export type TrackingStatus = "ACTIVE" | "COMPLETED";

export type SessionView = {
  id: string;
  deviceId: string;
  startedAt: string;
  endedAt: string | null;
  status: TrackingStatus;
  locationCount: number;
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
  /**
   * Pass back as `?after=` on the next poll. It tracks `receivedAt`, not
   * `capturedAt` — see `listLocations` in ./service.ts for why.
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
