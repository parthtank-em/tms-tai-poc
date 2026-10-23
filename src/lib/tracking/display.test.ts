import { describe, expect, it } from "vitest";

import { mergeLocations, wasReplayed } from "./display";
import type { EventView, LocationView } from "./types";

const at = (id: string, capturedAt: string, receivedAt = capturedAt): LocationView => ({
  id,
  latitude: 21.17,
  longitude: 72.83,
  accuracy: null,
  capturedAt,
  receivedAt,
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

const event = (createdAt: string, actualCreatedAt: string): EventView => ({
  id: "e",
  type: "user.exited_geofence",
  target: "START",
  latitude: null,
  longitude: null,
  confidence: null,
  createdAt,
  actualCreatedAt,
  receivedAt: createdAt,
});

describe("wasReplayed", () => {
  it("flags an event Radar processed well after it happened", () => {
    expect(wasReplayed(event("2026-09-28T08:25:00.000Z", "2026-09-28T08:00:00.000Z"))).toBe(true);
  });

  it("does not flag a live event", () => {
    expect(wasReplayed(event("2026-09-28T08:00:03.000Z", "2026-09-28T08:00:00.000Z"))).toBe(false);
  });
});
