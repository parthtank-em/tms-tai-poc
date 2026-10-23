import { describe, expect, it } from "vitest";

import {
  mapTrackingEvent,
  mapTrackingWebhook,
  sessionGeofence,
  sessionTripExternalId,
  sessionUpdates,
} from "./radar";

const SESSION = "4f1d3c2a-0000-4000-8000-000000000001";
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
    geofence: { _id: "g1", tag: "tms-track-start", externalId: SESSION, description: "Start" },
    ...overrides,
  };
}

function tripEvent(overrides: Record<string, unknown> = {}) {
  return {
    _id: "evt-trip-1",
    type: "user.updated_trip",
    createdAt: "2026-10-21T09:05:00.000Z",
    actualCreatedAt: "2026-10-21T09:05:00.000Z",
    trip: {
      _id: "t1",
      externalId: sessionTripExternalId(SESSION),
      status: "started",
      eta: { duration: 14.5, distance: 8123.4 },
    },
    ...overrides,
  };
}

describe("sessionGeofence and sessionTripExternalId", () => {
  it("names a session's fences by tag and session id", () => {
    expect(sessionGeofence(SESSION, "START")).toEqual({ tag: "tms-track-start", externalId: SESSION });
    expect(sessionGeofence(SESSION, "DESTINATION")).toEqual({ tag: "tms-track-dest", externalId: SESSION });
  });

  it("prefixes the trip id so trip events are recognisably /tracking's", () => {
    expect(sessionTripExternalId(SESSION)).toBe(`tms-track-${SESSION}`);
  });
});

describe("mapTrackingEvent", () => {
  it("maps a geofence event on our start tag to the session and START", () => {
    const mapped = mapTrackingEvent(geofenceEvent(), USER);

    expect(mapped).toMatchObject({
      id: "evt-geofence-1",
      sessionId: SESSION,
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
  });

  it("maps the destination tag to DESTINATION", () => {
    const mapped = mapTrackingEvent(
      geofenceEvent({ geofence: { tag: "tms-track-dest", externalId: SESSION } }),
      USER,
    );
    expect(mapped?.target).toBe("DESTINATION");
  });

  it("takes the session from a trip event's prefixed id, with status and ETA", () => {
    expect(mapTrackingEvent(tripEvent(), USER)).toMatchObject({
      sessionId: SESSION,
      target: null,
      trip: { status: "STARTED", etaMinutes: 14.5, etaDistanceMeters: 8123 },
    });
  });

  it("leaves the Radar POC's fences and trips alone", () => {
    expect(
      mapTrackingEvent(geofenceEvent({ geofence: { tag: "tms-radar-start", externalId: SESSION } }), USER),
    ).toBeNull();
    expect(mapTrackingEvent(tripEvent({ trip: { externalId: SESSION, status: "started" } }), USER)).toBeNull();
  });

  it("ignores events with no fence or trip of ours", () => {
    expect(mapTrackingEvent({ _id: "p", type: "user.entered_place", createdAt: "2026-10-21T09:00:00Z" }, USER)).toBeNull();
  });

  it("falls back to createdAt when actualCreatedAt is missing", () => {
    const mapped = mapTrackingEvent(geofenceEvent({ actualCreatedAt: undefined }), USER);
    expect(mapped?.actualCreatedAt.toISOString()).toBe("2026-10-21T09:00:05.000Z");
  });
});

describe("mapTrackingWebhook", () => {
  it("accepts single-event delivery", () => {
    expect(mapTrackingWebhook({ event: geofenceEvent(), user: USER })).toHaveLength(1);
  });

  it("keeps only /tracking's events from a multiple-event delivery", () => {
    const mapped = mapTrackingWebhook({
      events: [geofenceEvent(), tripEvent(), { _id: "x", type: "user.entered_place" }],
      user: USER,
    });
    expect(mapped.map((event) => event.id)).toEqual(["evt-geofence-1", "evt-trip-1"]);
  });

  it("returns nothing for a body with neither shape", () => {
    expect(mapTrackingWebhook({ hello: "world" })).toEqual([]);
    expect(mapTrackingWebhook("nope")).toEqual([]);
  });
});

describe("sessionUpdates", () => {
  it("keeps the newest trip state by actualCreatedAt, not by delivery order", () => {
    const newer = mapTrackingEvent(
      tripEvent({
        _id: "a",
        actualCreatedAt: "2026-10-21T09:10:00Z",
        trip: { externalId: sessionTripExternalId(SESSION), status: "approaching", eta: { duration: 3 } },
      }),
      USER,
    )!;
    const older = mapTrackingEvent(tripEvent({ _id: "b", actualCreatedAt: "2026-10-21T09:05:00Z" }), USER)!;

    const update = sessionUpdates([newer, older]).get(SESSION);

    expect(update?.latest).toMatchObject({ status: "APPROACHING", etaMinutes: 3 });
    expect(update?.latest?.at.toISOString()).toBe("2026-10-21T09:10:00.000Z");
  });

  it("keeps an earlier event's ETA when the newest one has none, in either order", () => {
    const tripId = sessionTripExternalId(SESSION);
    const approaching = mapTrackingEvent(
      tripEvent({
        _id: "ap",
        actualCreatedAt: "2026-10-21T09:25:00Z",
        trip: { externalId: tripId, status: "approaching", eta: { duration: 4.5, distance: 1200 } },
      }),
      USER,
    )!;
    const arrived = mapTrackingEvent(
      tripEvent({
        _id: "ar",
        type: "user.arrived_at_trip_destination",
        actualCreatedAt: "2026-10-21T09:30:00Z",
        trip: { externalId: tripId, status: "arrived" },
      }),
      USER,
    )!;

    for (const delivery of [[approaching, arrived], [arrived, approaching]]) {
      expect(sessionUpdates(delivery).get(SESSION)?.latest).toMatchObject({
        status: "ARRIVED",
        etaMinutes: 4.5,
        etaDistanceMeters: 1200,
      });
    }
  });

  it("records the earliest start exit and the earliest arrival", () => {
    const exitLate = mapTrackingEvent(geofenceEvent({ _id: "e2", actualCreatedAt: "2026-10-21T09:20:00Z" }), USER)!;
    const exitEarly = mapTrackingEvent(geofenceEvent({ _id: "e1" }), USER)!;
    const arrived = mapTrackingEvent(
      tripEvent({ _id: "arr", type: "user.arrived_at_trip_destination", actualCreatedAt: "2026-10-21T09:30:00Z" }),
      USER,
    )!;

    const update = sessionUpdates([exitLate, exitEarly, arrived]).get(SESSION);

    expect(update?.departedAt?.toISOString()).toBe("2026-10-21T09:00:00.000Z");
    expect(update?.arrivedAt?.toISOString()).toBe("2026-10-21T09:30:00.000Z");
  });

  it("does not treat an exit from the destination as a departure", () => {
    const exitDestination = mapTrackingEvent(
      geofenceEvent({ geofence: { tag: "tms-track-dest", externalId: SESSION } }),
      USER,
    )!;
    expect(sessionUpdates([exitDestination]).get(SESSION)?.departedAt).toBeNull();
  });
});
