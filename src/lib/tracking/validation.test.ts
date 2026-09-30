import { describe, expect, it } from "vitest";

import {
  MAX_BULK_GEOFENCE_EVENTS,
  MAX_BULK_LOCATIONS,
  parseAfter,
  parseBulkLocations,
  parseGeofenceEvents,
  parseLocation,
  parseStartSession,
} from "./validation";

const point = {
  id: "0d5c3c3e-8d0f-4b8a-9d8e-2f5e9c1a7b11",
  latitude: 21.1702,
  longitude: 72.8311,
  capturedAt: "2026-09-28T08:32:00.000Z",
};

const fence = { latitude: 21.1702, longitude: 72.8311, radiusMeters: 500 };

const crossing = {
  id: "7b2e6a3c-51d4-4a0e-9f3b-6c8d2e1f0a44",
  type: "EXIT",
  capturedAt: "2026-09-30T09:50:12.000Z",
  isOffline: true,
};

describe("parseStartSession", () => {
  it("accepts and trims a device id", () => {
    expect(parseStartSession({ deviceId: "  device-123 " })).toEqual({
      ok: true,
      value: { deviceId: "device-123", geofence: null },
    });
  });

  it.each([undefined, {}, { deviceId: "" }, { deviceId: 42 }])("rejects %j", (body) => {
    expect(parseStartSession(body).ok).toBe(false);
  });

  it.each([undefined, null])("treats a geofence of %j as none", (geofence) => {
    const parsed = parseStartSession({ deviceId: "device-123", geofence });

    expect(parsed.ok && parsed.value.geofence).toBeNull();
  });

  it("accepts a geofence", () => {
    expect(parseStartSession({ deviceId: "device-123", geofence: fence })).toEqual({
      ok: true,
      value: { deviceId: "device-123", geofence: fence },
    });
  });

  it.each([
    ["not an object", "21.17,72.83"],
    ["missing longitude", { ...fence, longitude: undefined }],
    ["latitude out of range", { ...fence, latitude: 91 }],
    ["missing radius", { ...fence, radiusMeters: undefined }],
    ["radius below the minimum", { ...fence, radiusMeters: 10 }],
    ["radius above the maximum", { ...fence, radiusMeters: 1_000_000 }],
    ["fractional radius", { ...fence, radiusMeters: 250.5 }],
    ["radius as a string", { ...fence, radiusMeters: "500" }],
  ])("rejects a geofence with %s", (_label, geofence) => {
    const parsed = parseStartSession({ deviceId: "device-123", geofence });

    expect(parsed).toEqual({ ok: false, error: expect.stringContaining("geofence") });
  });
});

describe("parseLocation", () => {
  it("parses a valid point", () => {
    const parsed = parseLocation(point);

    expect(parsed.ok && parsed.value.capturedAt.toISOString()).toBe(point.capturedAt);
  });

  it.each([
    ["missing id", { ...point, id: undefined }],
    ["latitude out of range", { ...point, latitude: 91 }],
    ["longitude out of range", { ...point, longitude: -181 }],
    ["latitude as a string", { ...point, latitude: "21.17" }],
    ["unparseable capturedAt", { ...point, capturedAt: "yesterday" }],
  ])("rejects %s", (_label, body) => {
    expect(parseLocation(body).ok).toBe(false);
  });
});

describe("parseBulkLocations", () => {
  it("accepts a batch", () => {
    const parsed = parseBulkLocations({ locations: [point, { ...point, id: "second" }] });

    expect(parsed.ok && parsed.value).toHaveLength(2);
  });

  it("names the index of the bad point and rejects the whole batch", () => {
    const parsed = parseBulkLocations({ locations: [point, { ...point, latitude: 200 }] });

    expect(parsed).toEqual({ ok: false, error: expect.stringContaining("locations[1].latitude") });
  });

  it("rejects an empty or oversized batch", () => {
    expect(parseBulkLocations({ locations: [] }).ok).toBe(false);
    expect(
      parseBulkLocations({ locations: Array.from({ length: MAX_BULK_LOCATIONS + 1 }, () => point) }).ok,
    ).toBe(false);
  });
});

describe("parseGeofenceEvents", () => {
  it("accepts a batch", () => {
    const parsed = parseGeofenceEvents({
      events: [crossing, { ...crossing, id: "second", type: "ENTER", isOffline: false }],
    });

    expect(parsed.ok && parsed.value).toEqual([
      { ...crossing, capturedAt: new Date(crossing.capturedAt) },
      { ...crossing, id: "second", type: "ENTER", isOffline: false, capturedAt: new Date(crossing.capturedAt) },
    ]);
  });

  it.each([
    ["missing id", { ...crossing, id: undefined }, "id"],
    ["unknown type", { ...crossing, type: "DWELL" }, "type"],
    ["lower-case type", { ...crossing, type: "exit" }, "type"],
    ["unparseable capturedAt", { ...crossing, capturedAt: "yesterday" }, "capturedAt"],
    ["missing isOffline", { ...crossing, isOffline: undefined }, "isOffline"],
    ["isOffline as a string", { ...crossing, isOffline: "true" }, "isOffline"],
  ])("rejects an event with %s, naming the field", (_label, event, field) => {
    const parsed = parseGeofenceEvents({ events: [crossing, event] });

    expect(parsed).toEqual({ ok: false, error: expect.stringContaining(`events[1].${field}`) });
  });

  it("rejects an empty or oversized batch", () => {
    expect(parseGeofenceEvents({ events: [] }).ok).toBe(false);
    expect(parseGeofenceEvents({}).ok).toBe(false);
    expect(
      parseGeofenceEvents({ events: Array.from({ length: MAX_BULK_GEOFENCE_EVENTS + 1 }, () => crossing) }).ok,
    ).toBe(false);
  });
});

describe("parseAfter", () => {
  it("treats an absent cursor as no filter", () => {
    expect(parseAfter(null)).toEqual({ ok: true, value: null });
  });

  it("rejects garbage", () => {
    expect(parseAfter("not-a-date").ok).toBe(false);
  });
});
