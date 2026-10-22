import { describe, expect, it } from "vitest";

import { mapTrackingEvent, mapTrackingWebhook, sessionGeofence } from "./radar";

const SESSION = "7a2b9c1d-0000-4000-8000-000000000001";
const USER = { userId: "device-1", deviceId: "radar-device-1" };

function crossing(overrides: Record<string, unknown> = {}) {
  return {
    _id: "evt-1",
    type: "user.entered_geofence",
    createdAt: "2026-10-22T09:00:05.000Z",
    actualCreatedAt: "2026-10-22T09:00:00.000Z",
    location: { type: "Point", coordinates: [72.8441, 21.1832] },
    geofence: { _id: "g1", tag: "tms-track-dest", externalId: SESSION, description: "Destination" },
    ...overrides,
  };
}

describe("mapTrackingEvent", () => {
  it("maps an entry of our destination fence to the session", () => {
    const mapped = mapTrackingEvent(crossing(), USER);

    expect(mapped).toMatchObject({
      id: "evt-1",
      sessionId: SESSION,
      type: "ENTER",
      target: "DESTINATION",
      userId: "device-1",
      isOffline: false,
    });
    expect(mapped?.capturedAt.toISOString()).toBe("2026-10-22T09:00:00.000Z");
  });

  it("maps an exit of our start fence", () => {
    const mapped = mapTrackingEvent(
      crossing({
        type: "user.exited_geofence",
        geofence: { tag: "tms-track-start", externalId: SESSION },
      }),
      USER,
    );

    expect(mapped).toMatchObject({ type: "EXIT", target: "START" });
  });

  it("flags an event Radar processed well after it happened as offline", () => {
    const mapped = mapTrackingEvent(
      crossing({ createdAt: "2026-10-22T09:30:00.000Z", actualCreatedAt: "2026-10-22T09:00:00.000Z" }),
      USER,
    );

    expect(mapped?.isOffline).toBe(true);
    expect(mapped?.capturedAt.toISOString()).toBe("2026-10-22T09:00:00.000Z");
  });

  it("falls back to createdAt without actualCreatedAt", () => {
    const mapped = mapTrackingEvent(crossing({ actualCreatedAt: undefined }), USER);

    expect(mapped?.capturedAt.toISOString()).toBe("2026-10-22T09:00:05.000Z");
    expect(mapped?.isOffline).toBe(false);
  });

  it("prefers the event's own user over the delivery's", () => {
    const mapped = mapTrackingEvent(crossing({ user: { userId: "device-2" } }), USER);

    expect(mapped?.userId).toBe("device-2");
  });

  it.each([
    ["the Radar POC's fence", { geofence: { tag: "tms-radar-start", externalId: SESSION } }],
    ["an untagged fence", { geofence: { externalId: SESSION } }],
    ["a fence without an externalId", { geofence: { tag: "tms-track-start" } }],
    ["a trip event", { type: "user.approaching_trip_destination" }],
    ["a dwell event", { type: "user.dwelled_in_geofence" }],
    ["a missing id", { _id: undefined }],
    ["an unreadable createdAt", { createdAt: "yesterday" }],
  ])("ignores %s", (_, overrides) => {
    expect(mapTrackingEvent(crossing(overrides), USER)).toBeNull();
  });
});

describe("mapTrackingWebhook", () => {
  it("reads a single-event delivery", () => {
    expect(mapTrackingWebhook({ event: crossing(), user: USER })).toHaveLength(1);
  });

  it("keeps only our crossings from a multi-event delivery", () => {
    const events = mapTrackingWebhook({
      events: [
        crossing({ _id: "a" }),
        crossing({ _id: "b", geofence: { tag: "tms-radar-dest", externalId: SESSION } }),
        { _id: "c", type: "user.updated_trip", createdAt: "2026-10-22T09:00:00.000Z" },
      ],
      user: USER,
    });

    expect(events.map((event) => event.id)).toEqual(["a"]);
  });

  it.each([null, "text", {}, { events: "nope" }])("returns nothing for %j", (body) => {
    expect(mapTrackingWebhook(body)).toEqual([]);
  });
});

describe("sessionGeofence", () => {
  it("names a session's fence by tag and session id", () => {
    expect(sessionGeofence(SESSION, "START")).toEqual({ tag: "tms-track-start", externalId: SESSION });
    expect(sessionGeofence(SESSION, "DESTINATION")).toEqual({
      tag: "tms-track-dest",
      externalId: SESSION,
    });
  });
});
