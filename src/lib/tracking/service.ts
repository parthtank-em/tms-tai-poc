import { prisma } from "@/lib/prisma";
import { createTrip, deleteGeofence, updateTripStatus, upsertGeofence } from "@/lib/radar/client";
import { getRadarConfig, type RadarConfig } from "@/lib/radar/config";

import { isRoadsEnabled, snapToRoads } from "./google-roads";
import { computeRoute, getGoogleRoutesKey } from "./google-routes";
import { forecastHours, isWeatherEnabled } from "./google-weather";
import { encodePolyline } from "./polyline";
import {
  sessionGeofence,
  sessionTripExternalId,
  sessionUpdates,
  type MappedTrackingEvent,
} from "./radar";
import {
  TRIP_STATUSES,
  type Coordinates,
  type EventView,
  type LocationInput,
  type LocationView,
  type RerouteInput,
  type RoutePreview,
  type RouteView,
  type RouteWeather,
  type SessionFeed,
  type SessionView,
  type TrackingStatus,
  type WeatherAlertView,
  type WeatherPreview,
  type WeatherView,
} from "./types";
import type { PlanSessionInput, StartSessionInput } from "./validation";
import { buildRouteWeather, isRepeat, sampleRoute, type AlertDraft } from "./weather";

/**
 * Tracking persistence and the Radar calls that go with it. The route
 * handlers and server actions parse and respond; everything that touches the
 * database, Google or Radar lives here.
 *
 * The same flow as the Radar POC (src/lib/radar/service.ts), except that the
 * planned route comes from Google: planned on the portal or by the phone
 * (PLANNED, nothing in Radar yet), started by one phone (ACTIVE — two fences
 * and a Radar trip are created for that phone), stopped by it (COMPLETED).
 * Only a PLANNED session can be edited or deleted.
 */

type DecimalLike = { toString(): string };

const toNumber = (value: DecimalLike) => Number(value.toString());
const toNullableNumber = (value: DecimalLike | null) => (value ? toNumber(value) : null);

const SESSION_SELECT = {
  id: true,
  deviceId: true,
  status: true,
  tripStatus: true,
  createdAt: true,
  startedAt: true,
  endedAt: true,
  startAddress: true,
  startLatitude: true,
  startLongitude: true,
  startRadiusMeters: true,
  destinationAddress: true,
  destinationLatitude: true,
  destinationLongitude: true,
  destinationRadiusMeters: true,
  plannedDistanceMeters: true,
  plannedDurationMinutes: true,
  etaMinutes: true,
  etaDistanceMeters: true,
  radarUpdatedAt: true,
  departedAt: true,
  arrivedAt: true,
  radarSyncError: true,
  routeVersion: true,
  reroutedAt: true,
  currentRouteDistanceMeters: true,
  currentRouteDurationMinutes: true,
  drivenRouteError: true,
  weatherVersion: true,
  weatherCheckedAt: true,
  weatherError: true,
  _count: { select: { locations: true, events: true } },
} as const;

type SessionRow = {
  id: string;
  deviceId: string | null;
  status: SessionView["status"];
  tripStatus: SessionView["tripStatus"];
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  startAddress: string | null;
  startLatitude: DecimalLike;
  startLongitude: DecimalLike;
  startRadiusMeters: number;
  destinationAddress: string | null;
  destinationLatitude: DecimalLike;
  destinationLongitude: DecimalLike;
  destinationRadiusMeters: number;
  plannedDistanceMeters: number | null;
  plannedDurationMinutes: number | null;
  etaMinutes: number | null;
  etaDistanceMeters: number | null;
  radarUpdatedAt: Date | null;
  departedAt: Date | null;
  arrivedAt: Date | null;
  radarSyncError: string | null;
  routeVersion: number;
  reroutedAt: Date | null;
  currentRouteDistanceMeters: number | null;
  currentRouteDurationMinutes: number | null;
  drivenRouteError: string | null;
  weatherVersion: number;
  weatherCheckedAt: Date | null;
  weatherError: string | null;
  _count: { locations: number; events: number };
};

function toSessionView(row: SessionRow): SessionView {
  return {
    id: row.id,
    deviceId: row.deviceId,
    status: row.status,
    tripStatus: row.tripStatus,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    start: {
      address: row.startAddress,
      latitude: toNumber(row.startLatitude),
      longitude: toNumber(row.startLongitude),
      radiusMeters: row.startRadiusMeters,
    },
    destination: {
      address: row.destinationAddress,
      latitude: toNumber(row.destinationLatitude),
      longitude: toNumber(row.destinationLongitude),
      radiusMeters: row.destinationRadiusMeters,
    },
    planned:
      row.plannedDistanceMeters === null || row.plannedDurationMinutes === null
        ? null
        : { distanceMeters: row.plannedDistanceMeters, durationMinutes: row.plannedDurationMinutes },
    eta:
      row.etaMinutes === null
        ? null
        : { minutes: row.etaMinutes, distanceMeters: row.etaDistanceMeters },
    radarUpdatedAt: row.radarUpdatedAt?.toISOString() ?? null,
    departedAt: row.departedAt?.toISOString() ?? null,
    arrivedAt: row.arrivedAt?.toISOString() ?? null,
    radarSyncError: row.radarSyncError,
    locationCount: row._count.locations,
    eventCount: row._count.events,
    routeVersion: row.routeVersion,
    reroutedAt: row.reroutedAt?.toISOString() ?? null,
    rerouted:
      row.currentRouteDistanceMeters === null || row.currentRouteDurationMinutes === null
        ? null
        : { distanceMeters: row.currentRouteDistanceMeters, durationMinutes: row.currentRouteDurationMinutes },
    drivenRouteError: row.drivenRouteError,
    weatherVersion: row.weatherVersion,
    weatherCheckedAt: row.weatherCheckedAt?.toISOString() ?? null,
    weatherError: row.weatherError,
  };
}

// ---------------------------------------------------------------------------
// Planning — the portal (and, optionally, the phone). The one difference from
// the Radar POC: the route comes from Google.
// ---------------------------------------------------------------------------

export type PreviewRouteResult =
  | { outcome: "routed"; route: RoutePreview }
  | { outcome: "unconfigured" }
  | { outcome: "google_failed"; message: string };

/** Google's traffic-aware drive route between two points, without saving anything. */
export async function previewRoute(
  start: Coordinates,
  destination: Coordinates,
): Promise<PreviewRouteResult> {
  const apiKey = getGoogleRoutesKey();
  if (!apiKey) return { outcome: "unconfigured" };

  const result = await computeRoute(apiKey, start, destination);
  return result.ok
    ? { outcome: "routed", route: result.route }
    : { outcome: "google_failed", message: result.message };
}

type WeatherCheck = {
  checkpoints: RouteWeather["checkpoints"];
  alerts: AlertDraft[];
  /** Why some or all points have no forecast, or null. */
  error: string | null;
};

/**
 * The forecast at points along `path` for when the driver should reach each,
 * one Weather API call per point, in parallel. A point whose call fails is
 * left out; if all fail there are no checkpoints and `error` says why.
 */
async function checkRouteWeather(
  apiKey: string,
  path: [number, number][],
  from: Coordinates | null,
  durationMinutes: number,
  departAt: Date,
): Promise<WeatherCheck> {
  const points = sampleRoute(path, from, durationMinutes, departAt);
  if (points.length === 0) return { checkpoints: [], alerts: [], error: null };

  // Enough hours to cover the last point, plus the one it falls in.
  const lastAt = points.at(-1)!.expectedAt.getTime();
  const hours = Math.ceil((lastAt - Date.now()) / 3_600_000) + 1;

  const results = await Promise.all(points.map((point) => forecastHours(apiKey, point, hours)));
  const { checkpoints, alerts } = buildRouteWeather(
    points,
    results.map((result) => (result.ok ? result.hours : null)),
  );

  const failures = results.flatMap((result) => (result.ok ? [] : [result.message]));
  const error =
    failures.length === 0
      ? null
      : failures.length === results.length
        ? failures[0]
        : `${failures.length} of ${results.length} points have no forecast: ${failures[0]}`;

  return { checkpoints, alerts, error };
}

/**
 * The weather along a previewed route, leaving now — for the planner. Null
 * when the Weather API is off (GOOGLE_WEATHER_ENABLED) or there is no key.
 */
export async function previewWeather(route: RoutePreview): Promise<WeatherPreview | null> {
  const apiKey = getGoogleRoutesKey();
  if (!isWeatherEnabled() || !apiKey) return null;

  const { checkpoints, alerts, error } = await checkRouteWeather(
    apiKey,
    route.path,
    null,
    route.durationMinutes,
    new Date(),
  );

  return {
    checkpoints,
    alerts: alerts.map((alert) => ({
      kind: alert.kind,
      severity: alert.severity,
      message: alert.message,
      expectedAt: alert.expectedAt.toISOString(),
    })),
    error,
  };
}

/** The stored line back as `[longitude, latitude]` pairs, or null if it is not one. */
function toPath(value: unknown): [number, number][] | null {
  if (!Array.isArray(value)) return null;

  const path: [number, number][] = [];
  for (const pair of value) {
    if (Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1])) {
      path.push([pair[0], pair[1]]);
    }
  }
  return path.length > 0 ? path : null;
}

/** The columns a plan writes: both ends and the route between them. */
function planData(input: PlanSessionInput, route: RoutePreview) {
  const { start, destination } = input;

  return {
    startAddress: start.address,
    startLatitude: start.latitude,
    startLongitude: start.longitude,
    startRadiusMeters: start.radiusMeters,
    destinationAddress: destination.address,
    destinationLatitude: destination.latitude,
    destinationLongitude: destination.longitude,
    destinationRadiusMeters: destination.radiusMeters,
    plannedDistanceMeters: route.distanceMeters,
    plannedDurationMinutes: route.durationMinutes,
    plannedRoute: route.path,
  };
}

export type PlanSessionResult =
  | { outcome: "planned"; session: SessionView }
  | { outcome: "unconfigured" }
  | { outcome: "google_failed"; message: string };

/**
 * Saves a session as PLANNED. Nothing is created in Radar: the fences and the
 * Radar trip belong to a user, and no phone has picked the session up yet.
 *
 * The route is computed here rather than taken from the form's preview, so a
 * session is never saved with figures for points other than its own.
 */
export async function planSession(input: PlanSessionInput): Promise<PlanSessionResult> {
  const routed = await previewRoute(input.start, input.destination);
  if (routed.outcome !== "routed") return routed;

  const session = await prisma.trackingSession.create({
    data: planData(input, routed.route),
    select: SESSION_SELECT,
  });

  return { outcome: "planned", session: toSessionView(session) };
}

export type ReplanSessionResult =
  | PlanSessionResult
  | { outcome: "not_found" }
  | { outcome: "not_planned"; session: SessionView };

/** Changes a session's ends. Only while PLANNED — once a phone has it, Radar has the fences. */
export async function replanSession(
  sessionId: string,
  input: PlanSessionInput,
): Promise<ReplanSessionResult> {
  const routed = await previewRoute(input.start, input.destination);
  if (routed.outcome !== "routed") return routed;

  // The status condition sits in the write itself, so a phone starting the
  // session at the same moment cannot have its fences drawn from the old ends.
  const { count } = await prisma.trackingSession.updateMany({
    where: { id: sessionId, status: "PLANNED" },
    data: planData(input, routed.route),
  });

  const session = await findSession(sessionId);
  if (!session) return { outcome: "not_found" };
  return count === 1 ? { outcome: "planned", session } : { outcome: "not_planned", session };
}

export type DeleteSessionResult =
  | { outcome: "deleted" }
  | { outcome: "not_found" }
  | { outcome: "not_planned"; session: SessionView };

/** Deletes a session no phone has started. Started sessions are history and stay. */
export async function deletePlannedSession(sessionId: string): Promise<DeleteSessionResult> {
  const { count } = await prisma.trackingSession.deleteMany({
    where: { id: sessionId, status: "PLANNED" },
  });
  if (count === 1) return { outcome: "deleted" };

  const session = await findSession(sessionId);
  return session ? { outcome: "not_planned", session } : { outcome: "not_found" };
}

// ---------------------------------------------------------------------------
// Tracking — the phone
// ---------------------------------------------------------------------------

export type StartSessionResult =
  | { outcome: "started"; session: SessionView }
  | { outcome: "not_found" }
  | { outcome: "not_planned"; session: SessionView }
  | { outcome: "unconfigured" }
  | { outcome: "radar_failed"; message: string };

/**
 * A phone starts a planned session: it becomes ACTIVE and this phone's, and
 * both fences and the Radar trip are created for this phone's Radar user.
 *
 * Once only. The claim is a conditional write, so of two phones pressing Start
 * on the same session exactly one gets it; the other gets `not_planned`.
 *
 * All or nothing. If any Radar call fails the fences are removed and the
 * session goes back to PLANNED, so the phone never tracks a session Radar does
 * not know about and can simply retry.
 */
export async function startSession(
  sessionId: string,
  input: StartSessionInput,
): Promise<StartSessionResult> {
  const config = getRadarConfig();
  if (!config) return { outcome: "unconfigured" };

  const { deviceId } = input;

  const claimed = await prisma.trackingSession.updateMany({
    where: { id: sessionId, status: "PLANNED" },
    data: { status: "ACTIVE", deviceId, startedAt: new Date() },
  });

  if (claimed.count === 0) {
    const session = await findSession(sessionId);
    return session ? { outcome: "not_planned", session } : { outcome: "not_found" };
  }

  const fail = async (message: string): Promise<StartSessionResult> => {
    // Best effort: a fence that was never created just 404s.
    await deleteSessionFences(config, sessionId);
    await prisma.trackingSession.updateMany({
      where: { id: sessionId, status: "ACTIVE", deviceId },
      data: { status: "PLANNED", deviceId: null, startedAt: null },
    });
    return { outcome: "radar_failed", message };
  };

  const { start, destination } = (await findSession(sessionId))!;

  const fences = await Promise.all([
    upsertGeofence(config, sessionGeofence(sessionId, "START"), start, deviceId, {
      description: `Start of tracking session ${sessionId}`,
      metadata: { sessionId },
    }),
    upsertGeofence(config, sessionGeofence(sessionId, "DESTINATION"), destination, deviceId, {
      description: `Destination of tracking session ${sessionId}`,
      metadata: { sessionId },
    }),
  ]);
  const fenceError = fences.find((result) => !result.ok);
  if (fenceError && !fenceError.ok) return fail(fenceError.message);

  // The destination fence must exist before the trip that points at it.
  const radarTrip = await createTrip(config, {
    externalId: sessionTripExternalId(sessionId),
    userId: deviceId,
    destination: sessionGeofence(sessionId, "DESTINATION"),
  });
  if (!radarTrip.ok) return fail(radarTrip.message);

  const session = await prisma.trackingSession.update({
    where: { id: sessionId },
    data: {
      radarTripId: radarTrip.data._id,
      tripStatus: statusFromRadar(radarTrip.data.status ?? ""),
    },
    select: SESSION_SELECT,
  });

  return { outcome: "started", session: toSessionView(session) };
}

function statusFromRadar(status: string): SessionView["tripStatus"] {
  const upper = status.toUpperCase();
  return TRIP_STATUSES.find((value) => value === upper) ?? null;
}

function deleteSessionFences(config: RadarConfig, sessionId: string) {
  return Promise.all([
    deleteGeofence(config, sessionGeofence(sessionId, "START")),
    deleteGeofence(config, sessionGeofence(sessionId, "DESTINATION")),
  ]);
}

/** Newest first, by when the session was created. `status` narrows it, e.g. to what a phone can start. */
export async function listSessions(status: TrackingStatus | null = null): Promise<SessionView[]> {
  const sessions = await prisma.trackingSession.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    select: SESSION_SELECT,
  });

  return sessions.map(toSessionView);
}

export async function findSession(sessionId: string): Promise<SessionView | null> {
  const session = await prisma.trackingSession.findUnique({
    where: { id: sessionId },
    select: SESSION_SELECT,
  });

  return session ? toSessionView(session) : null;
}

/** The planned line alone, for the edit form's first render. */
export async function findPlannedPath(sessionId: string): Promise<[number, number][] | null> {
  const session = await prisma.trackingSession.findUnique({
    where: { id: sessionId },
    select: { plannedRoute: true },
  });
  return toPath(session?.plannedRoute);
}

export type RecordLocationsResult =
  | { outcome: "recorded"; inserted: number; routeVersion: number; weatherVersion: number }
  | { outcome: "not_found" }
  | { outcome: "not_started" };

/**
 * Stores route points, skipping any id already stored. One location is a batch
 * of one, so a retried single send is as idempotent as a retried batch.
 *
 * A COMPLETED session still accepts points: a phone that pressed Stop while
 * offline flushes its queue afterwards, and those points are still the route.
 * A PLANNED one does not — no phone is driving it.
 *
 * Answers with the current route version, so a phone that is behind (another
 * device rerouted, or a reroute response was lost) knows to fetch the route —
 * and the weather version, so it knows when there are new weather alerts.
 */
export async function recordLocations(
  sessionId: string,
  locations: LocationInput[],
): Promise<RecordLocationsResult> {
  const session = await prisma.trackingSession.findUnique({
    where: { id: sessionId },
    select: { status: true, routeVersion: true, weatherVersion: true },
  });
  if (!session) return { outcome: "not_found" };
  if (session.status === "PLANNED") return { outcome: "not_started" };

  const { count } = await prisma.trackingLocation.createMany({
    data: locations.map((location) => ({ ...location, sessionId })),
    skipDuplicates: true,
  });

  return {
    outcome: "recorded",
    inserted: count,
    routeVersion: session.routeVersion,
    weatherVersion: session.weatherVersion,
  };
}

// ---------------------------------------------------------------------------
// Rerouting — the phone notices it left the route, the server asks Google for
// a new one, and every viewer picks it up by its version number.
// ---------------------------------------------------------------------------

/** One reroute per minute at most: GPS can wobble across the threshold. */
const REROUTE_COOLDOWN_MS = 60_000;

const ROUTE_SELECT = {
  createdAt: true,
  routeVersion: true,
  plannedRoute: true,
  plannedDistanceMeters: true,
  plannedDurationMinutes: true,
  currentRoute: true,
  currentRouteDistanceMeters: true,
  currentRouteDurationMinutes: true,
  reroutedAt: true,
} as const;

type RouteRow = {
  createdAt: Date;
  routeVersion: number;
  plannedRoute: unknown;
  plannedDistanceMeters: number | null;
  plannedDurationMinutes: number | null;
  currentRoute: unknown;
  currentRouteDistanceMeters: number | null;
  currentRouteDurationMinutes: number | null;
  reroutedAt: Date | null;
};

/** The line and figures of the route to follow now: the latest reroute, or the planned route before any. */
function followedRoute(row: RouteRow) {
  const rerouted = row.routeVersion > 1;
  const path = toPath(rerouted ? row.currentRoute : row.plannedRoute);
  const distanceMeters = rerouted ? row.currentRouteDistanceMeters : row.plannedDistanceMeters;
  const durationMinutes = rerouted ? row.currentRouteDurationMinutes : row.plannedDurationMinutes;

  if (!path || distanceMeters === null || durationMinutes === null) return null;
  return { rerouted, path, distanceMeters, durationMinutes };
}

/** The route to follow now, as the phone draws it. */
function toRouteView(row: RouteRow): RouteView | null {
  const route = followedRoute(row);
  if (!route) return null;

  const { rerouted, path, distanceMeters, durationMinutes } = route;

  return {
    version: row.routeVersion,
    source: rerouted ? "REROUTE" : "PLANNED",
    distanceMeters,
    durationMinutes,
    polyline: encodePolyline(path),
    updatedAt: ((rerouted ? row.reroutedAt : null) ?? row.createdAt).toISOString(),
  };
}

export async function getCurrentRoute(
  sessionId: string,
): Promise<{ outcome: "found"; route: RouteView | null } | { outcome: "not_found" }> {
  const row = await prisma.trackingSession.findUnique({ where: { id: sessionId }, select: ROUTE_SELECT });
  return row ? { outcome: "found", route: toRouteView(row) } : { outcome: "not_found" };
}

export type RerouteResult =
  | { outcome: "rerouted"; route: RouteView }
  | { outcome: "current"; route: RouteView | null }
  | { outcome: "not_found" }
  | { outcome: "not_active" }
  | { outcome: "unconfigured" }
  | { outcome: "google_failed"; message: string };

/**
 * The phone found itself off the route: route again from where it is to the
 * destination with Google, and make that the route to follow (the previous
 * reroute is replaced; the planned route stays).
 *
 * No new route — just the current one back — when the phone was following an
 * older version (someone already rerouted), or within a minute of the last
 * reroute. The version bump is a conditional write, so two requests racing
 * produce one reroute.
 */
export async function rerouteSession(sessionId: string, input: RerouteInput): Promise<RerouteResult> {
  const session = await prisma.trackingSession.findUnique({
    where: { id: sessionId },
    select: { ...ROUTE_SELECT, status: true, destinationLatitude: true, destinationLongitude: true },
  });

  if (!session) return { outcome: "not_found" };
  if (session.status !== "ACTIVE") return { outcome: "not_active" };

  const current = () => ({ outcome: "current" as const, route: toRouteView(session) });

  if (input.routeVersion !== null && input.routeVersion < session.routeVersion) return current();
  if (session.reroutedAt && Date.now() - session.reroutedAt.getTime() < REROUTE_COOLDOWN_MS) {
    return current();
  }

  const routed = await previewRoute(input, {
    latitude: toNumber(session.destinationLatitude),
    longitude: toNumber(session.destinationLongitude),
  });
  if (routed.outcome !== "routed") return routed;

  const now = new Date();
  const { count } = await prisma.trackingSession.updateMany({
    where: { id: sessionId, status: "ACTIVE", routeVersion: session.routeVersion },
    data: {
      routeVersion: session.routeVersion + 1,
      currentRoute: routed.route.path,
      currentRouteDistanceMeters: routed.route.distanceMeters,
      currentRouteDurationMinutes: routed.route.durationMinutes,
      reroutedAt: now,
    },
  });

  if (count === 0) {
    // Another request rerouted first; answer with what it made.
    const latest = await getCurrentRoute(sessionId);
    return { outcome: "current", route: latest.outcome === "found" ? latest.route : null };
  }

  const route = toRouteView({
    ...session,
    routeVersion: session.routeVersion + 1,
    currentRoute: routed.route.path,
    currentRouteDistanceMeters: routed.route.distanceMeters,
    currentRouteDurationMinutes: routed.route.durationMinutes,
    reroutedAt: now,
  })!;

  return { outcome: "rerouted", route };
}

// ---------------------------------------------------------------------------
// The driven line, snapped to roads — the dashboard's view of the road the
// driver actually took.
// ---------------------------------------------------------------------------

/** Snap again once this many new points arrived, or the last snap is this old. */
const SNAP_EVERY_POINTS = 10;
const SNAP_MAX_AGE_MS = 5 * 60_000;

/**
 * Re-snaps all of a session's points to roads with Google's Roads API and
 * stores the line. Whole-route rather than incremental, so an offline batch
 * that lands in the middle is snapped in its place.
 *
 * Called after location uploads (rate-limited by the constants above) and at
 * Stop with `force`. Does nothing unless GOOGLE_ROADS_ENABLED is "true".
 * Failures are kept in `drivenRouteError`; the page then shows the raw points
 * instead.
 */
export async function refreshDrivenRoute(sessionId: string, options: { force?: boolean } = {}): Promise<void> {
  if (!isRoadsEnabled()) return;

  const apiKey = getGoogleRoutesKey();
  if (!apiKey) return;

  const session = await prisma.trackingSession.findUnique({
    where: { id: sessionId },
    select: { drivenRouteLocationCount: true, drivenRouteUpdatedAt: true },
  });
  if (!session) return;

  const count = await prisma.trackingLocation.count({ where: { sessionId } });
  const newPoints = count - session.drivenRouteLocationCount;
  if (count < 2 || newPoints <= 0) return;

  const recent =
    session.drivenRouteUpdatedAt && Date.now() - session.drivenRouteUpdatedAt.getTime() < SNAP_MAX_AGE_MS;
  if (!options.force && newPoints < SNAP_EVERY_POINTS && recent) return;

  const rows = await prisma.trackingLocation.findMany({
    where: { sessionId },
    orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
    select: { latitude: true, longitude: true },
  });
  const points = rows.map((row) => ({ latitude: toNumber(row.latitude), longitude: toNumber(row.longitude) }));

  const snapped = await snapToRoads(apiKey, points);

  // Counted either way, so a failing key is not retried on every upload.
  await prisma.trackingSession.update({
    where: { id: sessionId },
    data: {
      drivenRouteLocationCount: count,
      drivenRouteUpdatedAt: new Date(),
      ...(snapped.ok
        ? { drivenRoute: snapped.path, drivenRouteError: null }
        : { drivenRouteError: snapped.message }),
    },
  });
}

// ---------------------------------------------------------------------------
// Weather ahead — Google's hourly forecast along the road still to drive.
// Warns only: weather never changes the route.
// ---------------------------------------------------------------------------

/** Check the road ahead again this often while the session is ACTIVE. */
const WEATHER_REFRESH_MS = 30 * 60_000;

/** The stored check back, or null if there is none (or it is not one). */
function toRouteWeather(value: unknown): RouteWeather | null {
  if (!value || typeof value !== "object") return null;
  const weather = value as RouteWeather;
  return Array.isArray(weather.checkpoints) && typeof weather.checkedAt === "string" ? weather : null;
}

/**
 * Checks the weather along the route ahead of the driver — from their latest
 * position on the route they are following now — and raises an alert for each
 * new hazard.
 *
 * Called at Start and after a reroute with `force`, and after location uploads,
 * where it runs only when the last check is WEATHER_REFRESH_MS old or was for
 * an older route. Two uploads racing check once: the check is claimed with a
 * conditional write first. Does nothing unless GOOGLE_WEATHER_ENABLED is
 * "true". Failures are kept in `weatherError`, and the last good check stays.
 *
 * New alerts move `weatherVersion` up; the phone sees that in its next
 * locations response and fetches them with `getWeather`.
 */
export async function refreshWeather(sessionId: string, options: { force?: boolean } = {}): Promise<void> {
  if (!isWeatherEnabled()) return;

  const apiKey = getGoogleRoutesKey();
  if (!apiKey) return;

  const session = await prisma.trackingSession.findUnique({
    where: { id: sessionId },
    select: { ...ROUTE_SELECT, status: true, weatherRouteVersion: true, weatherCheckedAt: true },
  });
  if (!session || session.status !== "ACTIVE") return;

  const due =
    options.force ||
    session.weatherRouteVersion !== session.routeVersion ||
    !session.weatherCheckedAt ||
    Date.now() - session.weatherCheckedAt.getTime() >= WEATHER_REFRESH_MS;
  if (!due) return;

  const { count } = await prisma.trackingSession.updateMany({
    where: { id: sessionId, status: "ACTIVE", weatherCheckedAt: session.weatherCheckedAt },
    data: { weatherCheckedAt: new Date() },
  });
  if (count === 0) return;

  const route = followedRoute(session);
  if (!route) return;

  const latest = await prisma.trackingLocation.findFirst({
    where: { sessionId },
    orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
    select: { latitude: true, longitude: true },
  });
  const from = latest ? { latitude: toNumber(latest.latitude), longitude: toNumber(latest.longitude) } : null;

  const { checkpoints, alerts, error } = await checkRouteWeather(
    apiKey,
    route.path,
    from,
    route.durationMinutes,
    new Date(),
  );

  const checkedAt = new Date();
  const routeWeather: RouteWeather = {
    checkedAt: checkedAt.toISOString(),
    routeVersion: session.routeVersion,
    checkpoints,
  };

  await prisma.$transaction(async (tx) => {
    // A hazard already raised on this route — the same storm, seen again from
    // further along — is not raised again. The unique key is the backstop.
    const earlier = await tx.trackingWeatherAlert.findMany({
      where: { sessionId, routeVersion: session.routeVersion },
      select: { kind: true, severity: true, latitude: true, longitude: true, expectedAt: true },
    });
    const raisedBefore = earlier.map((alert) => ({
      ...alert,
      latitude: toNumber(alert.latitude),
      longitude: toNumber(alert.longitude),
    }));
    const fresh = alerts.filter((alert) => !isRepeat(alert, raisedBefore));

    const { count: raised } = await tx.trackingWeatherAlert.createMany({
      data: fresh.map((alert) => ({
        sessionId,
        routeVersion: session.routeVersion,
        kind: alert.kind,
        severity: alert.severity,
        message: alert.message,
        condition: alert.condition,
        latitude: alert.latitude,
        longitude: alert.longitude,
        distanceAheadMeters: alert.distanceAheadMeters,
        expectedAt: alert.expectedAt,
        expectedHour: alert.expectedHour,
      })),
      skipDuplicates: true,
    });

    // The phone fetches again when this goes up: for new alerts, and for a new
    // route's first check, whose alert list replaces the old route's.
    const newRoute = checkpoints.length > 0 && session.weatherRouteVersion !== session.routeVersion;

    await tx.trackingSession.update({
      where: { id: sessionId },
      data: {
        weatherCheckedAt: checkedAt,
        weatherError: error,
        // Keep the last good check when every point failed.
        ...(checkpoints.length > 0
          ? { routeWeather, weatherRouteVersion: session.routeVersion }
          : {}),
        ...(raised > 0 || newRoute ? { weatherVersion: { increment: 1 } } : {}),
      },
    });
  });
}

/** Alerts this long past their expected time are no longer sent to the phone. */
const ALERT_STALE_AFTER_MS = 60 * 60_000;

/**
 * The weather ahead for the phone: the last check's points and the alerts on
 * the route to follow now that are not long past. The phone calls it when a
 * locations response's `weatherVersion` is higher than the one it has, and
 * notifies the driver of each alert id it has not shown before.
 */
export async function getWeather(
  sessionId: string,
): Promise<{ outcome: "found"; weather: WeatherView } | { outcome: "not_found" }> {
  const session = await prisma.trackingSession.findUnique({
    where: { id: sessionId },
    select: { routeVersion: true, weatherVersion: true, weatherCheckedAt: true, routeWeather: true },
  });
  if (!session) return { outcome: "not_found" };

  const rows = await prisma.trackingWeatherAlert.findMany({
    where: {
      sessionId,
      routeVersion: session.routeVersion,
      expectedAt: { gte: new Date(Date.now() - ALERT_STALE_AFTER_MS) },
    },
    orderBy: [{ expectedAt: "asc" }, { id: "asc" }],
  });

  // Points from an earlier route's check are not the road ahead any more.
  const routeWeather = toRouteWeather(session.routeWeather);
  const checkpoints = routeWeather?.routeVersion === session.routeVersion ? routeWeather.checkpoints : [];

  return {
    outcome: "found",
    weather: {
      version: session.weatherVersion,
      routeVersion: session.routeVersion,
      checkedAt: session.weatherCheckedAt?.toISOString() ?? null,
      checkpoints,
      alerts: rows.map(toWeatherAlertView),
    },
  };
}

function toWeatherAlertView(row: {
  id: string;
  routeVersion: number;
  kind: WeatherAlertView["kind"];
  severity: WeatherAlertView["severity"];
  message: string;
  condition: string;
  latitude: DecimalLike;
  longitude: DecimalLike;
  distanceAheadMeters: number;
  expectedAt: Date;
  createdAt: Date;
}): WeatherAlertView {
  return {
    id: row.id,
    routeVersion: row.routeVersion,
    kind: row.kind,
    severity: row.severity,
    message: row.message,
    condition: row.condition,
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    distanceAheadMeters: row.distanceAheadMeters,
    expectedAt: row.expectedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export type StopResult =
  | { outcome: "stopped"; session: SessionView }
  | { outcome: "not_found" }
  | { outcome: "not_active"; session: SessionView };

/**
 * Ends the session here, completes its Radar trip and deletes both fences.
 *
 * The stop itself never fails on Radar's account: the phone needs a definite
 * answer, and a Radar trip left open simply expires. A failed Radar call is
 * kept in `radarSyncError` for the session page instead.
 */
export async function stopSession(sessionId: string): Promise<StopResult> {
  // The status condition sits in the write itself, so two racing Stops cannot
  // both succeed.
  const { count } = await prisma.trackingSession.updateMany({
    where: { id: sessionId, status: "ACTIVE" },
    data: { status: "COMPLETED", endedAt: new Date() },
  });

  if (count === 1) await closeRadarTrip(sessionId);

  const session = await findSession(sessionId);

  if (!session) return { outcome: "not_found" };
  return count === 1 ? { outcome: "stopped", session } : { outcome: "not_active", session };
}

const FINAL_STATUSES = new Set(["COMPLETED", "CANCELED", "EXPIRED"]);

async function closeRadarTrip(sessionId: string): Promise<void> {
  const config = getRadarConfig();
  if (!config) {
    await prisma.trackingSession.update({
      where: { id: sessionId },
      data: { radarSyncError: "Radar is not configured — trip and fences were left open in Radar." },
    });
    return;
  }

  const current = await prisma.trackingSession.findUnique({
    where: { id: sessionId },
    select: { tripStatus: true },
  });

  const alreadyClosed = current?.tripStatus ? FINAL_STATUSES.has(current.tripStatus) : false;

  const [trip, ...fences] = await Promise.all([
    alreadyClosed
      ? Promise.resolve({ ok: true as const, data: null })
      : updateTripStatus(config, sessionTripExternalId(sessionId), "completed"),
    deleteGeofence(config, sessionGeofence(sessionId, "START")),
    deleteGeofence(config, sessionGeofence(sessionId, "DESTINATION")),
  ]);

  const errors = [trip, ...fences].flatMap((result) => (result.ok ? [] : [result.message]));
  const now = new Date();

  await prisma.trackingSession.update({
    where: { id: sessionId },
    data: {
      radarSyncError: errors.length > 0 ? errors.join("\n") : null,
      // Radar will also say so by webhook, but the page should not wait on it.
      ...(trip.ok && !alreadyClosed ? { tripStatus: "COMPLETED", radarUpdatedAt: now } : {}),
    },
  });
}

/**
 * Everything the session page needs for one poll.
 *
 * With `after`, only rows **received** at or after it — an offline batch or a
 * replayed Radar event lands late with an old timestamp, and filtering on
 * capture time would never return it. The comparison is `>=` so rows written
 * in the cursor's millisecond are not skipped; the client drops the overlap by
 * id.
 *
 * The planned route's line comes only with the first load: it is fixed once
 * the session is started, and resending it every five seconds would be waste.
 * The reroute line and the snapped driven line come with the first load and
 * whenever they changed at or after `after`. They do not move the cursor —
 * that stays on rows — so a change is sent until the next row arrives, which
 * is harmless and cannot skip a row.
 */
export async function getFeed(sessionId: string, after: Date | null): Promise<SessionFeed | null> {
  const session = await findSession(sessionId);
  if (!session) return null;

  const where = { sessionId, ...(after ? { receivedAt: { gte: after } } : {}) };

  const [locationRows, eventRows, alertRows, lines] = await Promise.all([
    prisma.trackingLocation.findMany({
      where,
      orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        latitude: true,
        longitude: true,
        accuracy: true,
        capturedAt: true,
        receivedAt: true,
      },
    }),
    prisma.trackingEvent.findMany({
      where,
      orderBy: [{ actualCreatedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        type: true,
        target: true,
        latitude: true,
        longitude: true,
        confidence: true,
        createdAt: true,
        actualCreatedAt: true,
        receivedAt: true,
      },
    }),
    prisma.trackingWeatherAlert.findMany({
      where: { sessionId, ...(after ? { createdAt: { gte: after } } : {}) },
      orderBy: [{ expectedAt: "asc" }, { id: "asc" }],
    }),
    prisma.trackingSession.findUnique({
      where: { id: sessionId },
      select: {
        plannedRoute: !after,
        currentRoute: true,
        reroutedAt: true,
        drivenRoute: true,
        drivenRouteUpdatedAt: true,
        routeWeather: true,
        weatherCheckedAt: true,
      },
    }),
  ]);

  const changedSince = (at: Date | null | undefined) => !after || (!!at && at >= after);

  const locations: LocationView[] = locationRows.map((row) => ({
    id: row.id,
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    accuracy: row.accuracy,
    capturedAt: row.capturedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
  }));

  const events: EventView[] = eventRows.map((row) => ({
    id: row.id,
    type: row.type,
    target: row.target,
    latitude: toNullableNumber(row.latitude),
    longitude: toNullableNumber(row.longitude),
    confidence: row.confidence,
    createdAt: row.createdAt.toISOString(),
    actualCreatedAt: row.actualCreatedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
  }));

  const weatherAlerts = alertRows.map(toWeatherAlertView);

  const latestReceived = [
    ...locationRows.map((row) => row.receivedAt),
    ...eventRows.map((row) => row.receivedAt),
    ...alertRows.map((row) => row.createdAt),
  ].reduce<Date | null>((latest, at) => (!latest || at > latest ? at : latest), null);

  return {
    session,
    plannedPath: toPath(lines?.plannedRoute),
    currentPath: changedSince(lines?.reroutedAt) ? toPath(lines?.currentRoute) : null,
    drivenPath: changedSince(lines?.drivenRouteUpdatedAt) ? toPath(lines?.drivenRoute) : null,
    locations,
    events,
    routeWeather: changedSince(lines?.weatherCheckedAt) ? toRouteWeather(lines?.routeWeather) : null,
    weatherAlerts,
    cursor: (latestReceived ?? after)?.toISOString() ?? null,
  };
}

export type IngestTrackingResult = { stored: number; unknownSession: number; wrongUser: number };

/**
 * Stores webhook events and moves each session's trip state forward.
 *
 * Idempotent: events are keyed on Radar's `_id`, and the session updates are
 * "newest wins" (status, ETA) and "earliest wins" (departed, arrived) against
 * what is already stored — so a redelivery, or two deliveries racing, end in
 * the same state.
 *
 * An event whose user is not the session's device is dropped. The fences are
 * scoped to that device, so this should not happen; it is a backstop. A
 * PLANNED session has no device, so nothing is stored against it.
 */
export async function ingestTrackingEvents(
  events: MappedTrackingEvent[],
): Promise<IngestTrackingResult> {
  if (events.length === 0) return { stored: 0, unknownSession: 0, wrongUser: 0 };

  const sessionIds = [...new Set(events.map((event) => event.sessionId))];
  const sessions = await prisma.trackingSession.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true, deviceId: true },
  });
  const deviceOf = new Map(sessions.map((session) => [session.id, session.deviceId]));

  let unknownSession = 0;
  let wrongUser = 0;

  const accepted = events.filter((event) => {
    const deviceId = deviceOf.get(event.sessionId);
    if (deviceId === undefined) {
      unknownSession++;
      return false;
    }
    if (deviceId === null || (event.userId !== null && event.userId !== deviceId)) {
      wrongUser++;
      return false;
    }
    return true;
  });

  const { count } = await prisma.trackingEvent.createMany({
    data: accepted.map((event) => ({
      id: event.id,
      sessionId: event.sessionId,
      type: event.type,
      target: event.target,
      latitude: event.latitude,
      longitude: event.longitude,
      accuracy: event.accuracy,
      confidence: event.confidence,
      createdAt: event.createdAt,
      actualCreatedAt: event.actualCreatedAt,
      payload: event.payload as object,
    })),
    skipDuplicates: true,
  });

  for (const [sessionId, update] of sessionUpdates(accepted)) {
    const writes = [];

    if (update.latest) {
      const { at, status, etaMinutes, etaDistanceMeters } = update.latest;
      writes.push(
        prisma.trackingSession.updateMany({
          where: { id: sessionId, OR: [{ radarUpdatedAt: null }, { radarUpdatedAt: { lt: at } }] },
          data: {
            radarUpdatedAt: at,
            ...(status ? { tripStatus: status } : {}),
            // A trip event without an ETA (e.g. arrived) keeps the last one.
            ...(etaMinutes !== null ? { etaMinutes, etaDistanceMeters } : {}),
          },
        }),
      );
    }

    if (update.departedAt) {
      const at = update.departedAt;
      writes.push(
        prisma.trackingSession.updateMany({
          where: { id: sessionId, OR: [{ departedAt: null }, { departedAt: { gt: at } }] },
          data: { departedAt: at },
        }),
      );
    }

    if (update.arrivedAt) {
      const at = update.arrivedAt;
      writes.push(
        prisma.trackingSession.updateMany({
          where: { id: sessionId, OR: [{ arrivedAt: null }, { arrivedAt: { gt: at } }] },
          data: { arrivedAt: at },
        }),
      );
    }

    await Promise.all(writes);
  }

  return { stored: count, unknownSession, wrongUser };
}
