import { describe, expect, it } from "vitest";

import type { ForecastHour } from "./google-weather";
import {
  assessHour,
  buildRouteWeather,
  hourAt,
  isRepeat,
  MAX_CHECKPOINTS,
  sampleRoute,
  type AlertDraft,
} from "./weather";

/** A clear hour at 10:00 UTC on 26 Oct 2026, India's offset; override what a test is about. */
function hour(overrides: Partial<ForecastHour> = {}, startHourUtc = 10): ForecastHour {
  return {
    startTime: new Date(Date.UTC(2026, 9, 26, startHourUtc)),
    endTime: new Date(Date.UTC(2026, 9, 26, startHourUtc + 1)),
    utcOffsetSeconds: 19_800,
    conditionType: "CLEAR",
    description: "Sunny",
    iconBaseUri: null,
    temperatureC: 30,
    precipitationPercent: 0,
    precipitationMm: 0,
    thunderstormPercent: 0,
    windGustKmh: 10,
    visibilityKm: 16,
    iceThicknessMm: 0,
    ...overrides,
  };
}

// Due north along longitude 72.9, one point every 0.01° (~1.1 km), ~111 km in all.
const path: [number, number][] = Array.from({ length: 101 }, (_, index) => [72.9, 21 + index * 0.01]);
const departAt = new Date(Date.UTC(2026, 9, 26, 10));

describe("sampleRoute", () => {
  it("takes the start, one point about every 25 km, and the end", () => {
    const points = sampleRoute(path, null, 120, departAt);

    expect(points[0]).toMatchObject({ latitude: 21, distanceAheadMeters: 0 });
    expect(points.at(-1)!.latitude).toBeCloseTo(22);
    expect(points).toHaveLength(5);
    // Evenly spread in time: the end at the route's duration.
    expect(points.at(-1)!.expectedAt.getTime() - departAt.getTime()).toBeCloseTo(120 * 60_000, -3);
  });

  it("starts from the point nearest the driver and keeps the route's pace", () => {
    const points = sampleRoute(path, { latitude: 21.5, longitude: 72.901 }, 120, departAt);

    expect(points[0].latitude).toBeCloseTo(21.5);
    expect(points[0].distanceAheadMeters).toBe(0);
    // Half the route left, so about half the time.
    const minutes = (points.at(-1)!.expectedAt.getTime() - departAt.getTime()) / 60_000;
    expect(minutes).toBeGreaterThan(58);
    expect(minutes).toBeLessThan(62);
  });

  it("spaces points wider on a long route to stay within the cap", () => {
    const long: [number, number][] = Array.from({ length: 1001 }, (_, index) => [72.9, 10 + index * 0.01]);
    expect(sampleRoute(long, null, 900, departAt).length).toBeLessThanOrEqual(MAX_CHECKPOINTS);
  });

  it("returns nothing for an empty path", () => {
    expect(sampleRoute([], null, 10, departAt)).toEqual([]);
  });
});

describe("hourAt", () => {
  const hours = [hour({}, 10), hour({}, 11)];

  it("finds the hour covering the time", () => {
    expect(hourAt(hours, new Date(Date.UTC(2026, 9, 26, 11, 30)))).toBe(hours[1]);
  });

  it("uses the first hour for a time just before the forecast starts", () => {
    expect(hourAt(hours, new Date(Date.UTC(2026, 9, 26, 9, 59)))).toBe(hours[0]);
  });

  it("is null past the forecast", () => {
    expect(hourAt(hours, new Date(Date.UTC(2026, 9, 26, 12, 0)))).toBeNull();
  });
});

describe("assessHour", () => {
  it("finds nothing in clear weather", () => {
    expect(assessHour(hour())).toEqual([]);
  });

  it("grades heavy rain by the rain rate", () => {
    expect(assessHour(hour({ precipitationMm: 9 }))).toEqual([{ kind: "HEAVY_RAIN", severity: "WARNING" }]);
    expect(assessHour(hour({ precipitationMm: 30 }))).toEqual([{ kind: "HEAVY_RAIN", severity: "SEVERE" }]);
  });

  it("takes Google's condition type as well as the numbers", () => {
    expect(assessHour(hour({ conditionType: "SCATTERED_THUNDERSTORMS" }))).toEqual([
      { kind: "THUNDERSTORM", severity: "WARNING" },
    ]);
  });

  it("reports several hazards in one hour", () => {
    const kinds = assessHour(hour({ windGustKmh: 95, visibilityKm: 0.5, temperatureC: 43 })).map((h) => h.kind);
    expect(kinds).toEqual(["STRONG_WIND", "LOW_VISIBILITY", "EXTREME_HEAT"]);
  });
});

describe("isRepeat", () => {
  const at = new Date(Date.UTC(2026, 9, 26, 10, 55));
  const raised = [{ kind: "HEAVY_RAIN" as const, severity: "WARNING" as const, latitude: 21.4, longitude: 72.9, expectedAt: at }];

  function draft(overrides: Partial<AlertDraft> = {}): AlertDraft {
    return {
      kind: "HEAVY_RAIN",
      severity: "WARNING",
      latitude: 21.4,
      longitude: 72.9,
      message: "",
      condition: "",
      distanceAheadMeters: 0,
      expectedAt: at,
      expectedHour: at,
      ...overrides,
    };
  }

  it("is the same storm seen again a little later and further along", () => {
    // Ten minutes later and ~11 km on — across an hour boundary, which used to raise it twice.
    expect(isRepeat(draft({ latitude: 21.5, expectedAt: new Date(at.getTime() + 10 * 60_000) }), raised)).toBe(true);
  });

  it("is news when it got worse", () => {
    expect(isRepeat(draft({ severity: "SEVERE" }), raised)).toBe(false);
  });

  it("is news for another kind, somewhere else, or hours apart", () => {
    expect(isRepeat(draft({ kind: "STRONG_WIND" }), raised)).toBe(false);
    expect(isRepeat(draft({ latitude: 21.8 }), raised)).toBe(false); // ~44 km away
    expect(isRepeat(draft({ expectedAt: new Date(at.getTime() + 2 * 3_600_000) }), raised)).toBe(false);
  });
});

describe("buildRouteWeather", () => {
  it("makes rain along the whole route one alert, from where it starts", () => {
    const points = sampleRoute(path, null, 150, departAt);
    // Three forecast hours, rain in all of them: the band spans the hours, so still one alert.
    const rainy = [10, 11, 12].map((utcHour) => hour({ precipitationMm: 9, description: "Heavy rain" }, utcHour));

    const { checkpoints, alerts } = buildRouteWeather(points, points.map(() => rainy));

    expect(checkpoints).toHaveLength(points.length);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "HEAVY_RAIN", distanceAheadMeters: 0 });
    // 10:00 UTC is 15:30 in India.
    expect(alerts[0].message).toBe("Heavy rain (up to 9 mm/h) expected close by around 15:30, for about 111 km");
  });

  it("takes the worst severity along the stretch, and quotes its figure", () => {
    const points = sampleRoute(path, null, 50, departAt);
    const forecasts = points.map((_, index) => [hour({ precipitationMm: index === 2 ? 40 : 9 })]);

    const { alerts } = buildRouteWeather(points, forecasts);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "SEVERE", distanceAheadMeters: 0 });
    expect(alerts[0].message).toMatch(/^Heavy rain \(up to 40 mm\/h\) expected close by /);
  });

  it("makes separate bands of the same hazard separate alerts", () => {
    const points = sampleRoute(path, null, 50, departAt);
    // Rain, a dry point, rain again.
    const forecasts = points.map((_, index) => [hour({ precipitationMm: index === 1 ? 0 : 9 })]);

    const { alerts } = buildRouteWeather(points, forecasts);

    expect(alerts.map((alert) => alert.distanceAheadMeters)).toEqual([0, points[2].distanceAheadMeters]);
    // A single point quotes its own figure, not a bound.
    expect(alerts[0].message).toBe("Heavy rain (9 mm/h) expected close by around 15:30");
  });

  it("says visibility as a lower bound", () => {
    const points = sampleRoute(path, null, 50, departAt);
    const forecasts = points.map(() => [hour({ visibilityKm: 0.3 })]);

    expect(buildRouteWeather(points, forecasts).alerts[0].message).toMatch(/^Low visibility \(down to 300 m\)/);
  });

  it("dates an alert by Google's forecast hour, not the UTC clock hour", () => {
    // India's forecast hours run :30 to :30 UTC: a 10:20 UTC arrival is in the 09:30 hour.
    const halfPast = {
      ...hour({ precipitationMm: 9 }),
      startTime: new Date(Date.UTC(2026, 9, 26, 9, 30)),
      endTime: new Date(Date.UTC(2026, 9, 26, 10, 30)),
    };
    const points = [
      { latitude: 21, longitude: 72.9, distanceAheadMeters: 0, expectedAt: new Date(Date.UTC(2026, 9, 26, 10, 20)) },
    ];

    const { alerts } = buildRouteWeather(points, [[halfPast]]);

    expect(alerts[0].expectedHour.toISOString()).toBe("2026-10-26T09:30:00.000Z");
  });

  it("leaves out points whose forecast failed", () => {
    const points = sampleRoute(path, null, 50, departAt);
    const forecasts = points.map((_, index) => (index === 0 ? null : [hour()]));

    expect(buildRouteWeather(points, forecasts).checkpoints).toHaveLength(points.length - 1);
  });
});
