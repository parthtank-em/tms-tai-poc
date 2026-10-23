import { prisma } from "@/lib/prisma";

import {
  createTrip,
  deleteGeofence,
  routeDistance,
  tripGeofence,
  updateTripStatus,
  upsertGeofence,
  type RadarRouteResponse,
} from "./client";
import { getRadarConfig } from "./config";
import { tripUpdates, type MappedEvent } from "./mapper";
import {
  RADAR_TRIP_STATUSES,
  type Coordinates,
  type LocationInput,
  type RadarEventView,
  type RadarFeed,
  type RadarLocationView,
  type RadarTripLifecycle,
  type RadarTripView,
  type RoutePreview,
} from "./types";
import type { PlanTripInput, StartTripInput } from "./validation";

/**
 * Radar trip persistence and the Radar calls that go with it. The route
 * handlers and server actions parse and respond; everything that touches the
 * database or Radar lives here.
 *
 * A trip's life: planned on the portal (PLANNED, nothing in Radar yet), started
 * by one phone (ACTIVE — fences and the Radar trip are created for that phone),
 * stopped by it (COMPLETED). Only a PLANNED trip can be edited or deleted.
 */

type DecimalLike = { toString(): string };

const toNumber = (value: DecimalLike) => Number(value.toString());
const toNullableNumber = (value: DecimalLike | null) => (value ? toNumber(value) : null);

const TRIP_SELECT = {
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

type TripRow = {
  id: string;
  deviceId: string | null;
  status: RadarTripView["status"];
  tripStatus: RadarTripView["tripStatus"];
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

function toTripView(row: TripRow): RadarTripView {
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
// Planning — the portal
// ---------------------------------------------------------------------------

// The address boxes use Google Places in the browser (trip-planner.tsx), so
// planning on the server starts at the route.

export type PreviewRouteResult =
  | { outcome: "routed"; route: RoutePreview }
  | { outcome: "unconfigured" }
  | { outcome: "radar_failed"; message: string };

/** Radar's truck route between two points, without saving anything. */
export async function previewRoute(
  start: Coordinates,
  destination: Coordinates,
): Promise<PreviewRouteResult> {
  const config = getRadarConfig();
  if (!config) return { outcome: "unconfigured" };

  const result = await routeDistance(config, start, destination);
  if (!result.ok) return { outcome: "radar_failed", message: result.message };

  const route = toRoutePreview(result.data);
  return route
    ? { outcome: "routed", route }
    : { outcome: "radar_failed", message: "Radar returned a route without a distance or duration." };
}

function toRoutePreview(route: RadarRouteResponse): RoutePreview | null {
  const distance = route.distance?.value;
  const duration = route.duration?.value;
  if (typeof distance !== "number" || typeof duration !== "number") return null;

  return {
    distanceMeters: Math.round(distance),
    durationMinutes: duration,
    path: route.geometry?.coordinates ?? [],
  };
}

/** The stored line back as `[longitude, latitude]` pairs, or null if it is not one. */
function toPath(value: unknown): [number, number][] | null {
  if (!Array.isArray(value)) return null;

  const path = value.filter(
    (pair): pair is [number, number] =>
      Array.isArray(pair) && pair.length >= 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]),
  );
  return path.length > 0
    ? path.map(([longitude, latitude]): [number, number] => [longitude, latitude])
    : null;
}

/** The columns a plan writes: both ends and the route between them. */
function planData(input: PlanTripInput, route: RoutePreview) {
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

export type PlanTripResult =
  | { outcome: "planned"; trip: RadarTripView }
  | { outcome: "unconfigured" }
  | { outcome: "radar_failed"; message: string };

/**
 * Saves a trip as PLANNED. Nothing is created in Radar: the fences and the
 * Radar trip belong to a user, and no phone has picked the trip up yet.
 *
 * The route is computed here rather than taken from the form's preview, so a
 * trip is never saved with figures for points other than its own.
 */
export async function planTrip(input: PlanTripInput): Promise<PlanTripResult> {
  const routed = await previewRoute(input.start, input.destination);
  if (routed.outcome !== "routed") return routed;

  const trip = await prisma.radarTrip.create({
    data: planData(input, routed.route),
    select: TRIP_SELECT,
  });

  return { outcome: "planned", trip: toTripView(trip) };
}

export type ReplanTripResult =
  | PlanTripResult
  | { outcome: "not_found" }
  | { outcome: "not_planned"; trip: RadarTripView };

/** Changes a trip's ends. Only while PLANNED — once a phone has it, Radar has the fences. */
export async function replanTrip(tripId: string, input: PlanTripInput): Promise<ReplanTripResult> {
  const routed = await previewRoute(input.start, input.destination);
  if (routed.outcome !== "routed") return routed;

  // The status condition sits in the write itself, so a phone starting the
  // trip at the same moment cannot have its fences drawn from the old ends.
  const { count } = await prisma.radarTrip.updateMany({
    where: { id: tripId, status: "PLANNED" },
    data: planData(input, routed.route),
  });

  const trip = await findTrip(tripId);
  if (!trip) return { outcome: "not_found" };
  return count === 1 ? { outcome: "planned", trip } : { outcome: "not_planned", trip };
}

export type DeleteTripResult =
  | { outcome: "deleted" }
  | { outcome: "not_found" }
  | { outcome: "not_planned"; trip: RadarTripView };

/** Deletes a trip that no phone has started. Started trips are history and stay. */
export async function deletePlannedTrip(tripId: string): Promise<DeleteTripResult> {
  const { count } = await prisma.radarTrip.deleteMany({ where: { id: tripId, status: "PLANNED" } });
  if (count === 1) return { outcome: "deleted" };

  const trip = await findTrip(tripId);
  return trip ? { outcome: "not_planned", trip } : { outcome: "not_found" };
}

// ---------------------------------------------------------------------------
// Tracking — the phone
// ---------------------------------------------------------------------------

export type StartTripResult =
  | { outcome: "started"; trip: RadarTripView }
  | { outcome: "not_found" }
  | { outcome: "not_planned"; trip: RadarTripView }
  | { outcome: "unconfigured" }
  | { outcome: "radar_failed"; message: string };

/**
 * A phone starts a planned trip: the trip becomes ACTIVE and this phone's, and
 * both fences and the Radar trip are created for this phone's Radar user.
 *
 * Once only. The claim is a conditional write, so of two phones pressing Start
 * on the same trip exactly one gets it; the other gets `not_planned`.
 *
 * All or nothing. If any Radar call fails the fences are removed and the trip
 * goes back to PLANNED, so the phone never tracks a trip Radar does not know
 * about and can simply retry.
 */
export async function startTrip(tripId: string, input: StartTripInput): Promise<StartTripResult> {
  const config = getRadarConfig();
  if (!config) return { outcome: "unconfigured" };

  const { deviceId } = input;

  const claimed = await prisma.radarTrip.updateMany({
    where: { id: tripId, status: "PLANNED" },
    data: { status: "ACTIVE", deviceId, startedAt: new Date() },
  });

  if (claimed.count === 0) {
    const trip = await findTrip(tripId);
    return trip ? { outcome: "not_planned", trip } : { outcome: "not_found" };
  }

  const fail = async (message: string): Promise<StartTripResult> => {
    // Best effort: a fence that was never created just 404s.
    await Promise.all([
      deleteGeofence(config, tripGeofence(tripId, "START")),
      deleteGeofence(config, tripGeofence(tripId, "DESTINATION")),
    ]);
    await prisma.radarTrip.updateMany({
      where: { id: tripId, status: "ACTIVE", deviceId },
      data: { status: "PLANNED", deviceId: null, startedAt: null },
    });
    return { outcome: "radar_failed", message };
  };

  const { start, destination } = (await findTrip(tripId))!;

  const fences = await Promise.all([
    upsertGeofence(config, tripGeofence(tripId, "START"), start, deviceId, {
      description: `Start of trip ${tripId}`,
      metadata: { tripId },
    }),
    upsertGeofence(config, tripGeofence(tripId, "DESTINATION"), destination, deviceId, {
      description: `Destination of trip ${tripId}`,
      metadata: { tripId },
    }),
  ]);
  const fenceError = fences.find((result) => !result.ok);
  if (fenceError && !fenceError.ok) return fail(fenceError.message);

  // The destination fence must exist before the trip that points at it.
  const radarTrip = await createTrip(config, {
    externalId: tripId,
    userId: deviceId,
    destination: tripGeofence(tripId, "DESTINATION"),
  });
  if (!radarTrip.ok) return fail(radarTrip.message);

  const trip = await prisma.radarTrip.update({
    where: { id: tripId },
    data: {
      radarTripId: radarTrip.data._id,
      tripStatus: statusFromRadar(radarTrip.data.status ?? ""),
    },
    select: TRIP_SELECT,
  });

  return { outcome: "started", trip: toTripView(trip) };
}

function statusFromRadar(status: string): RadarTripView["tripStatus"] {
  const upper = status.toUpperCase();
  return RADAR_TRIP_STATUSES.find((value) => value === upper) ?? null;
}

/** Newest first, by when the trip was planned. `status` narrows it, e.g. to what a phone can start. */
export async function listTrips(status: RadarTripLifecycle | null = null): Promise<RadarTripView[]> {
  const trips = await prisma.radarTrip.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    select: TRIP_SELECT,
  });

  return trips.map(toTripView);
}

export async function findTrip(tripId: string): Promise<RadarTripView | null> {
  const trip = await prisma.radarTrip.findUnique({ where: { id: tripId }, select: TRIP_SELECT });
  return trip ? toTripView(trip) : null;
}

export type RecordLocationsResult =
  | { outcome: "recorded"; inserted: number }
  | { outcome: "not_found" }
  | { outcome: "not_started" };

/**
 * Stores route points, skipping any id already stored. One location is a batch
 * of one, so a retried single send is as idempotent as a retried batch.
 *
 * A COMPLETED trip still accepts points: a phone that pressed Stop while
 * offline flushes its queue afterwards, and those points are still the route.
 * A PLANNED one does not — no phone is driving it.
 */
export async function recordLocations(
  tripId: string,
  locations: LocationInput[],
): Promise<RecordLocationsResult> {
  const trip = await prisma.radarTrip.findUnique({ where: { id: tripId }, select: { status: true } });
  if (!trip) return { outcome: "not_found" };
  if (trip.status === "PLANNED") return { outcome: "not_started" };

  const { count } = await prisma.radarTripLocation.createMany({
    data: locations.map((location) => ({ ...location, tripId })),
    skipDuplicates: true,
  });

  return { outcome: "recorded", inserted: count };
}

export type StopResult =
  | { outcome: "stopped"; trip: RadarTripView }
  | { outcome: "not_found" }
  | { outcome: "not_active"; trip: RadarTripView };

/**
 * Ends the trip here, completes it in Radar and deletes both fences.
 *
 * The stop itself never fails on Radar's account: the phone needs a definite
 * answer, and a Radar trip left open simply expires. A failed Radar call is
 * kept in `radarSyncError` for the trip page instead.
 */
export async function stopTrip(tripId: string): Promise<StopResult> {
  // The status condition sits in the write itself, so two racing Stops cannot
  // both succeed.
  const { count } = await prisma.radarTrip.updateMany({
    where: { id: tripId, status: "ACTIVE" },
    data: { status: "COMPLETED", endedAt: new Date() },
  });

  if (count === 1) await closeRadarTrip(tripId);

  const trip = await findTrip(tripId);

  if (!trip) return { outcome: "not_found" };
  return count === 1 ? { outcome: "stopped", trip } : { outcome: "not_active", trip };
}

const FINAL_STATUSES = new Set(["COMPLETED", "CANCELED", "EXPIRED"]);

async function closeRadarTrip(tripId: string): Promise<void> {
  const config = getRadarConfig();
  if (!config) {
    await prisma.radarTrip.update({
      where: { id: tripId },
      data: { radarSyncError: "Radar is not configured — trip and fences were left open in Radar." },
    });
    return;
  }

  const current = await prisma.radarTrip.findUnique({
    where: { id: tripId },
    select: { tripStatus: true },
  });

  const alreadyClosed = current?.tripStatus ? FINAL_STATUSES.has(current.tripStatus) : false;

  const [trip, ...fences] = await Promise.all([
    alreadyClosed
      ? Promise.resolve({ ok: true as const, data: null })
      : updateTripStatus(config, tripId, "completed"),
    deleteGeofence(config, tripGeofence(tripId, "START")),
    deleteGeofence(config, tripGeofence(tripId, "DESTINATION")),
  ]);

  const errors = [trip, ...fences].flatMap((result) => (result.ok ? [] : [result.message]));
  const now = new Date();

  await prisma.radarTrip.update({
    where: { id: tripId },
    data: {
      radarSyncError: errors.length > 0 ? errors.join("\n") : null,
      // Radar will also say so by webhook, but the page should not wait on it.
      ...(trip.ok && !alreadyClosed ? { tripStatus: "COMPLETED", radarUpdatedAt: now } : {}),
    },
  });
}

/**
 * Everything the trip page needs for one poll.
 *
 * With `after`, only rows **received** at or after it — an offline batch or a
 * replayed Radar event lands late with an old timestamp, and filtering on
 * capture time would never return it. The comparison is `>=` so rows written
 * in the cursor's millisecond are not skipped; the client drops the overlap by
 * id.
 *
 * The planned route's line comes only with the first load: it is fixed once
 * the trip is started, and resending it every five seconds would be waste.
 */
export async function getFeed(tripId: string, after: Date | null): Promise<RadarFeed | null> {
  const trip = await findTrip(tripId);
  if (!trip) return null;

  const where = { tripId, ...(after ? { receivedAt: { gte: after } } : {}) };

  const [locationRows, eventRows, planned] = await Promise.all([
    prisma.radarTripLocation.findMany({
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
    prisma.radarEvent.findMany({
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
      : prisma.radarTrip.findUnique({ where: { id: tripId }, select: { plannedRoute: true } }),
  ]);

  const locations: RadarLocationView[] = locationRows.map((row) => ({
    id: row.id,
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    accuracy: row.accuracy,
    capturedAt: row.capturedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
  }));

  const events: RadarEventView[] = eventRows.map((row) => ({
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
    trip,
    plannedPath: toPath(planned?.plannedRoute),
    locations,
    events,
    cursor: (latestReceived ?? after)?.toISOString() ?? null,
  };
}

/** The planned line alone, for the edit form's first render. */
export async function findPlannedPath(tripId: string): Promise<[number, number][] | null> {
  const trip = await prisma.radarTrip.findUnique({
    where: { id: tripId },
    select: { plannedRoute: true },
  });
  return toPath(trip?.plannedRoute);
}

export type IngestResult = { stored: number; unknownTrip: number; wrongUser: number };

/**
 * Stores webhook events and moves each trip's state forward.
 *
 * Idempotent: events are keyed on Radar's `_id`, and the trip updates are
 * "newest wins" (status, ETA) and "earliest wins" (departed, arrived) against
 * what is already stored — so a redelivery, or two deliveries racing, end in
 * the same state.
 *
 * An event whose user is not the trip's device is dropped. The fences are
 * scoped to that device, so this should not happen; it is a backstop. A
 * PLANNED trip has no device, so nothing is stored against it.
 */
export async function ingestEvents(events: MappedEvent[]): Promise<IngestResult> {
  if (events.length === 0) return { stored: 0, unknownTrip: 0, wrongUser: 0 };

  const tripIds = [...new Set(events.map((event) => event.tripId))];
  const trips = await prisma.radarTrip.findMany({
    where: { id: { in: tripIds } },
    select: { id: true, deviceId: true },
  });
  const deviceOf = new Map(trips.map((trip) => [trip.id, trip.deviceId]));

  let unknownTrip = 0;
  let wrongUser = 0;

  const accepted = events.filter((event) => {
    const deviceId = deviceOf.get(event.tripId);
    if (deviceId === undefined) {
      unknownTrip++;
      return false;
    }
    if (deviceId === null || (event.userId !== null && event.userId !== deviceId)) {
      wrongUser++;
      return false;
    }
    return true;
  });

  const { count } = await prisma.radarEvent.createMany({
    data: accepted.map((event) => ({
      id: event.id,
      tripId: event.tripId,
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

  for (const [tripId, update] of tripUpdates(accepted)) {
    const writes = [];

    if (update.latest) {
      const { at, status, etaMinutes, etaDistanceMeters } = update.latest;
      writes.push(
        prisma.radarTrip.updateMany({
          where: { id: tripId, OR: [{ radarUpdatedAt: null }, { radarUpdatedAt: { lt: at } }] },
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
        prisma.radarTrip.updateMany({
          where: { id: tripId, OR: [{ departedAt: null }, { departedAt: { gt: at } }] },
          data: { departedAt: at },
        }),
      );
    }

    if (update.arrivedAt) {
      const at = update.arrivedAt;
      writes.push(
        prisma.radarTrip.updateMany({
          where: { id: tripId, OR: [{ arrivedAt: null }, { arrivedAt: { gt: at } }] },
          data: { arrivedAt: at },
        }),
      );
    }

    await Promise.all(writes);
  }

  return { stored: count, unknownTrip, wrongUser };
}
