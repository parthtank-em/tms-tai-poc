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
const destination = { latitude: 21.1832, longitude: 72.8441, radiusMeters: 300 };

const trip = {
  deviceId: "device-123",
  start: fence,
  destination,
  distanceMeters: 1_950,
  eta: "2026-10-02T12:52:30.000Z",
};

const crossing = {
  id: "7b2e6a3c-51d4-4a0e-9f3b-6c8d2e1f0a44",
  type: "EXIT",
  target: "START",
  capturedAt: "2026-09-30T09:50:12.000Z",
  isOffline: true,
};

describe("parseStartSession", () => {
  it("accepts a trip and trims the device id", () => {
    expect(parseStartSession({ ...trip, deviceId: "  device-123 " })).toEqual({
      ok: true,
      value: { ...trip, eta: new Date(trip.eta) },
    });
  });

  it("accepts a zero distance", () => {
    expect(parseStartSession({ ...trip, distanceMeters: 0 }).ok).toBe(true);
  });

  it.each([undefined, {}, { ...trip, deviceId: "" }, { ...trip, deviceId: 42 }])("rejects %j", (body) => {
    expect(parseStartSession(body).ok).toBe(false);
  });

  it.each(["start", "destination"] as const)("requires %s", (field) => {
    expect(parseStartSession({ ...trip, [field]: undefined })).toEqual({
      ok: false,
      error: expect.stringContaining(`${field} is required`),
    });
    expect(parseStartSession({ ...trip, [field]: null }).ok).toBe(false);
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
  ])("rejects a destination with %s, naming the field", (_label, value) => {
    const parsed = parseStartSession({ ...trip, destination: value });

    expect(parsed).toEqual({ ok: false, error: expect.stringContaining("destination") });
  });

  it.each([
    ["missing", undefined],
    ["negative", -1],
    ["fractional", 10.5],
    ["a string", "1950"],
  ])("rejects a distanceMeters that is %s", (_label, distanceMeters) => {
    expect(parseStartSession({ ...trip, distanceMeters })).toEqual({
      ok: false,
      error: expect.stringContaining("distanceMeters"),
    });
  });

  it.each([undefined, "soon", 1_700_000_000])("rejects an eta of %j", (eta) => {
    expect(parseStartSession({ ...trip, eta })).toEqual({
      ok: false,
      error: expect.stringContaining("eta"),
    });
  });
});

describe("parseLocation", () => {
  it("parses a valid point", () => {
    const parsed = parseLocation(point);

    expect(parsed.ok && parsed.value.capturedAt.toISOString()).toBe(point.capturedAt);
  });

  it("treats missing or null progress figures as unknown", () => {
    expect(parseLocation(point)).toMatchObject({
      ok: true,
      value: { remainingDistanceMeters: null, eta: null },
    });
    expect(parseLocation({ ...point, remainingDistanceMeters: null, eta: null })).toMatchObject({
      ok: true,
      value: { remainingDistanceMeters: null, eta: null },
    });
  });

  it("parses the remaining distance and ETA", () => {
    const parsed = parseLocation({
      ...point,
      remainingDistanceMeters: 84_200,
      eta: "2026-10-02T12:48:00.000Z",
    });

    expect(parsed).toMatchObject({
      ok: true,
      value: { remainingDistanceMeters: 84_200, eta: new Date("2026-10-02T12:48:00.000Z") },
    });
  });

  it.each([
    ["missing id", { ...point, id: undefined }],
    ["latitude out of range", { ...point, latitude: 91 }],
    ["longitude out of range", { ...point, longitude: -181 }],
    ["latitude as a string", { ...point, latitude: "21.17" }],
    ["unparseable capturedAt", { ...point, capturedAt: "yesterday" }],
    ["negative remaining distance", { ...point, remainingDistanceMeters: -5 }],
    ["remaining distance as a string", { ...point, remainingDistanceMeters: "84200" }],
    ["unparseable eta", { ...point, eta: "soon" }],
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

  it("names the index of a bad eta", () => {
    const parsed = parseBulkLocations({ locations: [point, { ...point, eta: "soon" }] });

    expect(parsed).toEqual({ ok: false, error: expect.stringContaining("locations[1].eta") });
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
      events: [
        crossing,
        { ...crossing, id: "second", type: "ENTER", target: "DESTINATION", isOffline: false },
      ],
    });

    expect(parsed.ok && parsed.value).toEqual([
      { ...crossing, capturedAt: new Date(crossing.capturedAt) },
      {
        ...crossing,
        id: "second",
        type: "ENTER",
        target: "DESTINATION",
        isOffline: false,
        capturedAt: new Date(crossing.capturedAt),
      },
    ]);
  });

  it.each([
    ["missing id", { ...crossing, id: undefined }, "id"],
    ["unknown type", { ...crossing, type: "DWELL" }, "type"],
    ["lower-case type", { ...crossing, type: "exit" }, "type"],
    ["missing target", { ...crossing, target: undefined }, "target"],
    ["unknown target", { ...crossing, target: "WAYPOINT" }, "target"],
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
