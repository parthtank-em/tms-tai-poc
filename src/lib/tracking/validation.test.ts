import { describe, expect, it } from "vitest";

import {
  MAX_BULK_LOCATIONS,
  parseAfter,
  parseBulkLocations,
  parseLocation,
  parseStartSession,
} from "./validation";

const point = {
  id: "0d5c3c3e-8d0f-4b8a-9d8e-2f5e9c1a7b11",
  latitude: 21.1702,
  longitude: 72.8311,
  capturedAt: "2026-09-28T08:32:00.000Z",
};

describe("parseStartSession", () => {
  it("accepts and trims a device id", () => {
    expect(parseStartSession({ deviceId: "  device-123 " })).toEqual({
      ok: true,
      value: { deviceId: "device-123" },
    });
  });

  it.each([undefined, {}, { deviceId: "" }, { deviceId: 42 }])("rejects %j", (body) => {
    expect(parseStartSession(body).ok).toBe(false);
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

describe("parseAfter", () => {
  it("treats an absent cursor as no filter", () => {
    expect(parseAfter(null)).toEqual({ ok: true, value: null });
  });

  it("rejects garbage", () => {
    expect(parseAfter("not-a-date").ok).toBe(false);
  });
});
