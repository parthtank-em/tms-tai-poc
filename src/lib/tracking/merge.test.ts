import { describe, expect, it } from "vitest";

import { arrivedLate, mergeGeofenceEvents, mergeLocations } from "./merge";
import type { GeofenceEventView, LocationView } from "./types";

const at = (id: string, capturedAt: string, receivedAt = capturedAt): LocationView => ({
  id,
  latitude: 21.17,
  longitude: 72.83,
  capturedAt,
  receivedAt,
  remainingDistanceMeters: null,
  eta: null,
});

describe("mergeLocations", () => {
  it("drops ids the map already has", () => {
    const current = [at("a", "2026-09-28T08:00:00.000Z"), at("b", "2026-09-28T08:02:00.000Z")];
    const merged = mergeLocations(current, [at("b", "2026-09-28T08:02:00.000Z")]);

    expect(merged).toBe(current);
  });

  it("slots a late offline batch into capture order", () => {
    const current = [at("a", "2026-09-28T08:00:00.000Z"), at("d", "2026-09-28T08:06:00.000Z")];
    const merged = mergeLocations(current, [
      at("c", "2026-09-28T08:04:00.000Z", "2026-09-28T08:07:00.000Z"),
      at("b", "2026-09-28T08:02:00.000Z", "2026-09-28T08:07:00.000Z"),
    ]);

    expect(merged.map((location) => location.id)).toEqual(["a", "b", "c", "d"]);
  });
});

const crossing = (id: string, capturedAt: string, isOffline = false): GeofenceEventView => ({
  id,
  type: "EXIT",
  target: "START",
  capturedAt,
  receivedAt: "2026-09-30T10:10:00.000Z",
  isOffline,
});

describe("mergeGeofenceEvents", () => {
  it("drops ids already shown", () => {
    const current = [crossing("a", "2026-09-30T09:00:00.000Z")];

    expect(mergeGeofenceEvents(current, [crossing("a", "2026-09-30T09:00:00.000Z")])).toBe(current);
  });

  it("slots a late offline event into capture order", () => {
    const current = [crossing("a", "2026-09-30T09:00:00.000Z"), crossing("c", "2026-09-30T10:05:00.000Z")];
    const merged = mergeGeofenceEvents(current, [crossing("b", "2026-09-30T09:50:00.000Z", true)]);

    expect(merged.map((event) => event.id)).toEqual(["a", "b", "c"]);
  });
});

describe("arrivedLate", () => {
  it("flags a point that sat in the offline queue", () => {
    expect(arrivedLate(at("a", "2026-09-28T08:00:00.000Z", "2026-09-28T08:25:00.000Z"))).toBe(true);
  });

  it("does not flag a live send", () => {
    expect(arrivedLate(at("a", "2026-09-28T08:00:00.000Z", "2026-09-28T08:00:03.000Z"))).toBe(false);
  });
});
