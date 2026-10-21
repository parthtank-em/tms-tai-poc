import { describe, expect, it } from "vitest";

import { mapEvent, mapWebhook, tripUpdates } from "./mapper";

const TRIP = "4f1d3c2a-0000-4000-8000-000000000001";
const USER = { userId: "device-1", deviceId: "radar-device-1" };

function geofenceEvent(overrides: Record<string, unknown> = {}) {
  return {
    _id: "evt-geofence-1",
    type: "user.exited_geofence",
    createdAt: "2026-10-21T09:00:05.000Z",
    actualCreatedAt: "2026-10-21T09:00:00.000Z",
    live: false,
    location: { type: "Point", coordinates: [72.8311, 21.1702] },
    locationAccuracy: 12,
    confidence: 3,
    geofence: { _id: "g1", tag: "tms-radar-start", externalId: TRIP, description: "Start" },
    ...overrides,
  };
}

function tripEvent(overrides: Record<string, unknown> = {}) {
  return {
    _id: "evt-trip-1",
    type: "user.updated_trip",
    createdAt: "2026-10-21T09:05:00.000Z",
    actualCreatedAt: "2026-10-21T09:05:00.000Z",
    trip: { _id: "t1", externalId: TRIP, status: "started", eta: { duration: 14.5, distance: 8123.4 } },
    ...overrides,
  };
}

describe("mapEvent", () => {
  it("maps a geofence event on our start tag to the trip and START", () => {
    const mapped = mapEvent(geofenceEvent(), USER);

    expect(mapped).toMatchObject({
      id: "evt-geofence-1",
      tripId: TRIP,
      type: "user.exited_geofence",
      target: "START",
      userId: "device-1",
      latitude: 21.1702,
      longitude: 72.8311,
      accuracy: 12,
      confidence: 3,
      trip: null,
    });
    expect(mapped?.actualCreatedAt.toISOString()).toBe("2026-10-21T09:00:00.000Z");
    expect(mapped?.createdAt.toISOString()).toBe("2026-10-21T09:00:05.000Z");
  });

  it("maps the destination tag to DESTINATION", () => {
    const mapped = mapEvent(
      geofenceEvent({ geofence: { tag: "tms-radar-dest", externalId: TRIP } }),
      USER,
    );
    expect(mapped?.target).toBe("DESTINATION");
  });

  it("takes the trip from a trip event, with status and ETA", () => {
    const mapped = mapEvent(tripEvent(), USER);

    expect(mapped).toMatchObject({
      tripId: TRIP,
      target: null,
      trip: { status: "STARTED", etaMinutes: 14.5, etaDistanceMeters: 8123 },
    });
  });

  it("ignores geofences that are not ours and events with no trip", () => {
    expect(mapEvent(geofenceEvent({ geofence: { tag: "store", externalId: "123" } }), USER)).toBeNull();
    expect(mapEvent({ _id: "p", type: "user.entered_place", createdAt: "2026-10-21T09:00:00Z" }, USER)).toBeNull();
  });

  it("falls back to createdAt when actualCreatedAt is missing", () => {
    const mapped = mapEvent(geofenceEvent({ actualCreatedAt: undefined }), USER);
    expect(mapped?.actualCreatedAt.toISOString()).toBe("2026-10-21T09:00:05.000Z");
  });

  it("leaves an unknown trip status null rather than guessing", () => {
    const mapped = mapEvent(tripEvent({ trip: { externalId: TRIP, status: "teleported" } }), USER);
    expect(mapped?.trip).toEqual({ status: null, etaMinutes: null, etaDistanceMeters: null });
  });

  it("prefers a per-event user over the delivery's user", () => {
    const mapped = mapEvent(geofenceEvent({ user: { userId: "other" } }), USER);
    expect(mapped?.userId).toBe("other");
  });
});

describe("mapWebhook", () => {
  it("accepts single-event delivery", () => {
    const mapped = mapWebhook({ event: geofenceEvent(), user: USER });
    expect(mapped?.events).toHaveLength(1);
    expect(mapped?.ignored).toBe(0);
  });

  it("accepts multiple-event delivery and counts what it drops", () => {
    const mapped = mapWebhook({
      events: [geofenceEvent(), tripEvent(), { _id: "x", type: "user.entered_place" }],
      user: USER,
    });
    expect(mapped?.events.map((event) => event.id)).toEqual(["evt-geofence-1", "evt-trip-1"]);
    expect(mapped?.ignored).toBe(1);
  });

  it("rejects a body with neither shape", () => {
    expect(mapWebhook({ hello: "world" })).toBeNull();
    expect(mapWebhook("nope")).toBeNull();
  });
});

describe("tripUpdates", () => {
  it("keeps the newest trip state by actualCreatedAt, not by delivery order", () => {
    const newer = mapEvent(tripEvent({ _id: "a", actualCreatedAt: "2026-10-21T09:10:00Z", trip: { externalId: TRIP, status: "approaching", eta: { duration: 3 } } }), USER)!;
    const older = mapEvent(tripEvent({ _id: "b", actualCreatedAt: "2026-10-21T09:05:00Z" }), USER)!;

    const update = tripUpdates([newer, older]).get(TRIP);

    expect(update?.latest).toMatchObject({ status: "APPROACHING", etaMinutes: 3 });
    expect(update?.latest?.at.toISOString()).toBe("2026-10-21T09:10:00.000Z");
  });

  it("records the earliest start exit and the earliest arrival", () => {
    const exitLate = mapEvent(geofenceEvent({ _id: "e2", actualCreatedAt: "2026-10-21T09:20:00Z" }), USER)!;
    const exitEarly = mapEvent(geofenceEvent({ _id: "e1" }), USER)!;
    const arrived = mapEvent(
      tripEvent({ _id: "arr", type: "user.arrived_at_trip_destination", actualCreatedAt: "2026-10-21T09:30:00Z" }),
      USER,
    )!;

    const update = tripUpdates([exitLate, exitEarly, arrived]).get(TRIP);

    expect(update?.departedAt?.toISOString()).toBe("2026-10-21T09:00:00.000Z");
    expect(update?.arrivedAt?.toISOString()).toBe("2026-10-21T09:30:00.000Z");
  });

  it("does not treat an exit from the destination as a departure", () => {
    const exitDestination = mapEvent(
      geofenceEvent({ geofence: { tag: "tms-radar-dest", externalId: TRIP } }),
      USER,
    )!;
    expect(tripUpdates([exitDestination]).get(TRIP)?.departedAt).toBeNull();
  });
});
