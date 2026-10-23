import { describe, expect, it } from "vitest";

import {
  parseAfter,
  parseBulkLocations,
  parseLocation,
  parsePlanTrip,
  parseStartTrip,
  parseStatusFilter,
} from "./validation";

const START = { latitude: 21.1702, longitude: 72.8311, radiusMeters: 300 };
const DESTINATION = { latitude: 21.1832, longitude: 72.8441, radiusMeters: 300 };

describe("parseStartTrip", () => {
  it("accepts a device id, trimmed", () => {
    expect(parseStartTrip({ deviceId: " device-1 " })).toEqual({
      ok: true,
      value: { deviceId: "device-1" },
    });
  });

  it("requires a device id", () => {
    expect(parseStartTrip({}).ok).toBe(false);
    expect(parseStartTrip(undefined).ok).toBe(false);
  });

  it("ignores the ends an older app build still sends", () => {
    expect(parseStartTrip({ deviceId: "d", start: START, destination: DESTINATION })).toEqual({
      ok: true,
      value: { deviceId: "d" },
    });
  });
});

describe("parsePlanTrip", () => {
  it("accepts two ends, with or without an address", () => {
    expect(
      parsePlanTrip({ start: { ...START, address: " Surat Station " }, destination: DESTINATION }),
    ).toEqual({
      ok: true,
      value: {
        start: { ...START, address: "Surat Station" },
        destination: { ...DESTINATION, address: null },
      },
    });
  });

  it("treats an empty address as none", () => {
    const parsed = parsePlanTrip({ start: { ...START, address: "" }, destination: DESTINATION });
    expect(parsed.ok && parsed.value.start.address).toBeNull();
  });

  it("enforces Radar's 10 km circle limit", () => {
    expect(
      parsePlanTrip({ start: START, destination: { ...DESTINATION, radiusMeters: 10_001 } }),
    ).toEqual({
      ok: false,
      error: "destination.radiusMeters must be a whole number between 50 and 10000.",
    });
  });

  it("names the end that is missing", () => {
    expect(parsePlanTrip({ start: START })).toEqual({
      ok: false,
      error: "destination is required — an object with latitude, longitude and radiusMeters.",
    });
  });

  it("rejects an address that is not a string", () => {
    expect(parsePlanTrip({ start: { ...START, address: 42 }, destination: DESTINATION }).ok).toBe(false);
  });
});

describe("parseStatusFilter", () => {
  it("is optional", () => {
    expect(parseStatusFilter(null)).toEqual({ ok: true, value: null });
    expect(parseStatusFilter("")).toEqual({ ok: true, value: null });
  });

  it("accepts a lifecycle in any case", () => {
    expect(parseStatusFilter("planned")).toEqual({ ok: true, value: "PLANNED" });
  });

  it("rejects anything else", () => {
    expect(parseStatusFilter("DONE").ok).toBe(false);
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
