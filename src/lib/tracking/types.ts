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
  /** Goes up when there are new weather alerts (or a new route's first check): 0 = none yet. */
  weatherVersion: number;
  /** When the weather ahead was last checked, or null if never. */
  weatherCheckedAt: string | null;
  /** The last Weather API failure, or null. */
  weatherError: string | null;
};

/** What can make the road ahead hazardous, as judged from Google's hourly forecast. */
export type WeatherHazardKind =
  | "THUNDERSTORM"
  | "HEAVY_RAIN"
  | "SNOW_ICE"
  | "STRONG_WIND"
  | "LOW_VISIBILITY"
  | "EXTREME_HEAT";

export type WeatherSeverity = "WARNING" | "SEVERE";

export type WeatherHazard = {
  kind: WeatherHazardKind;
  severity: WeatherSeverity;
};

/** The forecast at one point on the route, for the hour the driver should reach it. */
export type WeatherCheckpoint = Coordinates & {
  /** Along the route from where the check started (the driver, or the source). */
  distanceAheadMeters: number;
  /** When the driver should be here, from the route's duration. */
  expectedAt: string;
  /** Google's description, e.g. "Light rain". */
  condition: string;
  /** Google's icon, without extension: append `.svg` or `.png`. */
  iconBaseUri: string | null;
  temperatureC: number | null;
  /** Chance of precipitation that hour, in percent. */
  precipitationPercent: number | null;
  hazards: WeatherHazard[];
};

/** The weather ahead along one route, as last checked. */
export type RouteWeather = {
  checkedAt: string;
  /** The route version it was checked for. */
  routeVersion: number;
  checkpoints: WeatherCheckpoint[];
};

/** The weather along a previewed route, leaving now. Nothing is stored. */
export type WeatherPreview = {
  checkpoints: WeatherCheckpoint[];
  alerts: (WeatherHazard & { message: string; expectedAt: string })[];
  /** Why some or all points have no forecast, or null. */
  error: string | null;
};

/**
 * One hazard ahead, worth telling the driver about: a stretch of road with it,
 * placed where it starts. Raised once, however often the weather is checked —
 * again only if it gets worse, or on a new route.
 */
export type WeatherAlertView = WeatherHazard &
  Coordinates & {
    id: string;
    routeVersion: number;
    /** Ready to show, e.g. "Heavy rain (9 mm/h) expected 42 km ahead around 14:00". */
    message: string;
    condition: string;
    distanceAheadMeters: number;
    expectedAt: string;
    createdAt: string;
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

/** The weather ahead, as the phone fetches it (`GET /weather`). */
export type WeatherView = {
  /** Keep it: fetch again when a locations response's `weatherVersion` is higher. */
  version: number;
  /** The route the alerts are for — always the route to follow now. */
  routeVersion: number;
  /** When the road ahead was last checked, or null if never. */
  checkedAt: string | null;
  /** The forecast at points ahead, nearest first; empty before the first check. */
  checkpoints: WeatherCheckpoint[];
  /**
   * The current route's alerts that are not long past, soonest first. Notify
   * the driver of each `id` you have not shown before.
   */
  alerts: WeatherAlertView[];
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
   * The latest weather check along the route. Sent on the first load and
   * whenever it was checked again since `after`; otherwise null (keep the one
   * you have).
   */
  routeWeather: RouteWeather | null;
  /** Weather alerts raised since `after`, ordered by `expectedAt` ascending. */
  weatherAlerts: WeatherAlertView[];
  /**
   * Pass back as `?after=` on the next poll. Tracks arrival (`receivedAt`)
   * across the lists, so a late offline batch or a replayed event is still
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
