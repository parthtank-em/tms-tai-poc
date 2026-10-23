import { prisma } from "@/lib/prisma";
import { createTrip, deleteGeofence, updateTripStatus, upsertGeofence } from "@/lib/radar/client";
import { getRadarConfig, type RadarConfig } from "@/lib/radar/config";

import { computeRoute, getGoogleRoutesKey } from "./google-routes";
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
  type RoutePreview,
  type SessionFeed,
  type SessionView,
  type TrackingStatus,
} from "./types";
import type { PlanSessionInput, StartSessionInput } from "./validation";

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
  | { outcome: "recorded"; inserted: number }
  | { outcome: "not_found" }
  | { outcome: "not_started" };

/**
 * Stores route points, skipping any id already stored. One location is a batch
 * of one, so a retried single send is as idempotent as a retried batch.
 *
 * A COMPLETED session still accepts points: a phone that pressed Stop while
 * offline flushes its queue afterwards, and those points are still the route.
 * A PLANNED one does not — no phone is driving it.
 */
export async function recordLocations(
  sessionId: string,
  locations: LocationInput[],
): Promise<RecordLocationsResult> {
  const session = await prisma.trackingSession.findUnique({
    where: { id: sessionId },
    select: { status: true },
  });
  if (!session) return { outcome: "not_found" };
  if (session.status === "PLANNED") return { outcome: "not_started" };

  const { count } = await prisma.trackingLocation.createMany({
    data: locations.map((location) => ({ ...location, sessionId })),
    skipDuplicates: true,
  });

  return { outcome: "recorded", inserted: count };
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
 */
export async function getFeed(sessionId: string, after: Date | null): Promise<SessionFeed | null> {
  const session = await findSession(sessionId);
  if (!session) return null;

  const where = { sessionId, ...(after ? { receivedAt: { gte: after } } : {}) };

  const [locationRows, eventRows, planned] = await Promise.all([
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
    after
      ? null
      : prisma.trackingSession.findUnique({ where: { id: sessionId }, select: { plannedRoute: true } }),
  ]);

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

  const latestReceived = [...locationRows, ...eventRows].reduce<Date | null>(
    (latest, row) => (!latest || row.receivedAt > latest ? row.receivedAt : latest),
    null,
  );

  return {
    session,
    plannedPath: toPath(planned?.plannedRoute),
    locations,
    events,
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
