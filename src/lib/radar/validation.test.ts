import { describe, expect, it } from "vitest";

import { parseAfter, parseBulkLocations, parseLocation, parseStartTrip } from "./validation";

const START = { latitude: 21.1702, longitude: 72.8311, radiusMeters: 300 };
const DESTINATION = { latitude: 21.1832, longitude: 72.8441, radiusMeters: 300 };

describe("parseStartTrip", () => {
  it("accepts a device id and two fences", () => {
    expect(parseStartTrip({ deviceId: " device-1 ", start: START, destination: DESTINATION })).toEqual({
      ok: true,
      value: { deviceId: "device-1", start: START, destination: DESTINATION },
    });
  });

  it("requires a device id", () => {
    const parsed = parseStartTrip({ start: START, destination: DESTINATION });
    expect(parsed.ok).toBe(false);
  });

  it("enforces Radar's 10 km circle limit", () => {
    const parsed = parseStartTrip({
      deviceId: "d",
      start: START,
      destination: { ...DESTINATION, radiusMeters: 10_001 },
    });
    expect(parsed).toEqual({
      ok: false,
      error: "destination.radiusMeters must be a whole number between 50 and 10000.",
    });
  });
});

describe("parseLocation", () => {
  const location = {
    id: "loc-1",
    latitude: 21.1702,
    longitude: 72.8311,
    capturedAt: "2026-10-21T09:00:00.000Z",
  };

  it("treats accuracy as optional", () => {
    const parsed = parseLocation(location);
    expect(parsed.ok && parsed.value.accuracy).toBeNull();
  });

  it("keeps a valid accuracy and rejects a malformed one", () => {
    const withAccuracy = parseLocation({ ...location, accuracy: 15.5 });
    expect(withAccuracy.ok && withAccuracy.value.accuracy).toBe(15.5);

    expect(parseLocation({ ...location, accuracy: "15" })).toEqual({
      ok: false,
      error: "location.accuracy must be a number of meters between 0 and 100000.",
    });
  });

  it("rejects string coordinates", () => {
    expect(parseLocation({ ...location, latitude: "21.17" }).ok).toBe(false);
  });
});

describe("parseBulkLocations", () => {
  it("names the bad item and rejects the whole batch", () => {
    const parsed = parseBulkLocations({
      locations: [
        { id: "a", latitude: 1, longitude: 1, capturedAt: "2026-10-21T09:00:00Z" },
        { id: "b", latitude: 91, longitude: 1, capturedAt: "2026-10-21T09:00:00Z" },
      ],
    });
    expect(parsed).toEqual({
      ok: false,
      error: "locations[1].latitude must be a number between -90 and 90.",
    });
  });

  it("rejects an empty batch", () => {
    expect(parseBulkLocations({ locations: [] }).ok).toBe(false);
  });
});

describe("parseAfter", () => {
  it("treats absent as everything and rejects garbage", () => {
    expect(parseAfter(null)).toEqual({ ok: true, value: null });
    expect(parseAfter("yesterday").ok).toBe(false);
  });
});
