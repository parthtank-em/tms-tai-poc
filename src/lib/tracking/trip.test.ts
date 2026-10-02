import { describe, expect, it } from "vitest";

import { formatDistance, latestProgress } from "./trip";
import type { LocationView } from "./types";

const at = (capturedAt: string, extra: Partial<LocationView> = {}): LocationView => ({
  id: capturedAt,
  latitude: 21.17,
  longitude: 72.83,
  capturedAt,
  receivedAt: capturedAt,
  remainingDistanceMeters: null,
  eta: null,
  ...extra,
});

const planned = { distanceMeters: 112_400, eta: "2026-10-02T12:52:30.000Z" };

describe("latestProgress", () => {
  it("falls back to the Start values when no point has figures", () => {
    expect(latestProgress([at("2026-10-02T11:00:00.000Z")], planned)).toEqual({
      remainingDistanceMeters: 112_400,
      eta: planned.eta,
      reportedAt: null,
    });
  });

  it("takes the newest capture, even when an older point arrived later", () => {
    const locations = [
      // Captured first, but uploaded last from the offline queue.
      at("2026-10-02T10:30:00.000Z", {
        receivedAt: "2026-10-02T11:10:00.000Z",
        remainingDistanceMeters: 95_000,
        eta: "2026-10-02T12:40:00.000Z",
      }),
      at("2026-10-02T11:05:00.000Z", {
        remainingDistanceMeters: 84_200,
        eta: "2026-10-02T12:48:00.000Z",
      }),
    ];

    expect(latestProgress(locations, planned)).toEqual({
      remainingDistanceMeters: 84_200,
      eta: "2026-10-02T12:48:00.000Z",
      reportedAt: "2026-10-02T11:05:00.000Z",
    });
  });

  it("skips newer points that carry no figures", () => {
    const locations = [
      at("2026-10-02T11:00:00.000Z", { remainingDistanceMeters: 90_000, eta: "2026-10-02T12:50:00.000Z" }),
      at("2026-10-02T11:02:00.000Z"),
    ];

    expect(latestProgress(locations, planned).remainingDistanceMeters).toBe(90_000);
  });
});

describe("formatDistance", () => {
  it.each([
    [null, "—"],
    [0, "0 m"],
    [850, "850 m"],
    [1_000, "1 km"],
    [112_400, "112.4 km"],
  ])("formats %j as %s", (meters, expected) => {
    expect(formatDistance(meters)).toBe(expected);
  });
});
