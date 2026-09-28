import { prisma } from "@/lib/prisma";

import type { LocationInput, LocationView, LocationsResponse, SessionView } from "./types";

/**
 * Tracking persistence. The route handlers parse and respond; everything that
 * touches the database lives here.
 */

type SessionRow = {
  id: string;
  deviceId: string;
  startedAt: Date;
  endedAt: Date | null;
  status: SessionView["status"];
  _count?: { locations: number };
};

export function toSessionView(row: SessionRow): SessionView {
  return {
    id: row.id,
    deviceId: row.deviceId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    status: row.status,
    locationCount: row._count?.locations ?? 0,
  };
}

type LocationRow = {
  id: string;
  latitude: { toString(): string };
  longitude: { toString(): string };
  capturedAt: Date;
  receivedAt: Date;
};

function toLocationView(row: LocationRow): LocationView {
  return {
    id: row.id,
    // Decimal(10, 7) is well inside float precision, so the conversion to a
    // plain number the map can use loses nothing.
    latitude: Number(row.latitude.toString()),
    longitude: Number(row.longitude.toString()),
    capturedAt: row.capturedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
  };
}

const SESSION_SELECT = {
  id: true,
  deviceId: true,
  startedAt: true,
  endedAt: true,
  status: true,
  _count: { select: { locations: true } },
} as const;

/** Every press of Start is a new session — nothing is resumed. */
export async function startSession(deviceId: string): Promise<SessionView> {
  const session = await prisma.trackingSession.create({
    data: { deviceId },
    select: SESSION_SELECT,
  });

  return toSessionView(session);
}

export async function listSessions(): Promise<SessionView[]> {
  const sessions = await prisma.trackingSession.findMany({
    orderBy: { startedAt: "desc" },
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

/**
 * Stores locations for a session, skipping any id already stored.
 *
 * Used for both the single and the bulk endpoint — one location is just a
 * batch of one, and taking the same path means a retried single send is as
 * idempotent as a retried batch.
 *
 * A COMPLETED session still accepts locations. A device that loses signal and
 * then presses Stop flushes its offline queue *after* the stop, and those
 * points belong to the route just as much as the ones sent live.
 */
export async function recordLocations(
  sessionId: string,
  locations: LocationInput[],
): Promise<{ found: false } | { found: true; inserted: number }> {
  const session = await prisma.trackingSession.findUnique({
    where: { id: sessionId },
    select: { id: true },
  });

  if (!session) return { found: false };

  const { count } = await prisma.trackingLocation.createMany({
    data: locations.map((location) => ({ ...location, sessionId })),
    skipDuplicates: true,
  });

  return { found: true, inserted: count };
}

export type StopResult =
  | { outcome: "stopped"; session: SessionView }
  | { outcome: "not_found" }
  | { outcome: "not_active"; session: SessionView };

export async function stopSession(sessionId: string): Promise<StopResult> {
  // The status condition sits in the write itself, so two Stop requests racing
  // each other cannot both succeed and overwrite `endedAt`.
  const { count } = await prisma.trackingSession.updateMany({
    where: { id: sessionId, status: "ACTIVE" },
    data: { status: "COMPLETED", endedAt: new Date() },
  });

  const session = await findSession(sessionId);

  if (!session) return { outcome: "not_found" };
  return count === 1 ? { outcome: "stopped", session } : { outcome: "not_active", session };
}

/**
 * A session's locations, oldest capture first.
 *
 * With `after`, only locations **received** at or after that instant. The
 * implementation plan (§8) suggests filtering on `capturedAt`, but that loses
 * exactly the case this POC exists to prove: an offline batch arrives late
 * carrying *old* capture times, all earlier than the newest point the map
 * already has, so a `capturedAt > last` filter would never return them.
 * Filtering on arrival picks them up, and the client re-sorts by `capturedAt`
 * so they slot into the right place on the route.
 *
 * The comparison is `>=`, not `>`: rows written in the same millisecond as the
 * cursor would otherwise be skipped. The overlap this causes is one or two
 * already-seen rows, which the client drops by id.
 */
export async function listLocations(
  sessionId: string,
  after: Date | null,
): Promise<LocationsResponse | null> {
  const session = await prisma.trackingSession.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true },
  });

  if (!session) return null;

  const rows = await prisma.trackingLocation.findMany({
    where: { sessionId, ...(after ? { receivedAt: { gte: after } } : {}) },
    orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
    select: { id: true, latitude: true, longitude: true, capturedAt: true, receivedAt: true },
  });

  const locations = rows.map(toLocationView);

  const latestReceived = rows.reduce<Date | null>(
    (latest, row) => (!latest || row.receivedAt > latest ? row.receivedAt : latest),
    null,
  );

  return {
    sessionId: session.id,
    status: session.status,
    locations,
    latestCapturedAt: locations.at(-1)?.capturedAt ?? null,
    cursor: (latestReceived ?? after)?.toISOString() ?? null,
  };
}
