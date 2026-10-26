import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getFeed, getWeather, recordLocations, refreshWeather } from "./service";

import { prisma } from "@/lib/prisma";

/**
 * Weather along the route, against a real Postgres: what a check stores, when
 * `weatherVersion` moves (the phone's cue to fetch), that a repeat check does
 * not raise the same alert twice, and what the phone and the dashboard get.
 *
 * Google's Weather API is stubbed — `fetch` answers with a forecast the test
 * chooses — so these prove our rules, not Google's forecast. Radar is not
 * involved: sessions are written straight in as ACTIVE.
 *
 * Every session created here is deleted afterwards (alerts and locations
 * cascade).
 */

type Weather = { type: string; description: string; rainMm: number };

const CLEAR: Weather = { type: "CLEAR", description: "Sunny", rainMm: 0 };
const HEAVY_RAIN: Weather = { type: "HEAVY_RAIN", description: "Heavy rain", rainMm: 12 };

/** What the stubbed Weather API forecasts everywhere, every hour. */
let forecast: Weather = CLEAR;
let weatherFails = false;

/** Six hours from the start of the current one, in Google's response shape. */
function forecastResponse(weather: Weather) {
  const firstHour = new Date();
  firstHour.setUTCMinutes(0, 0, 0);

  return {
    forecastHours: Array.from({ length: 6 }, (_, index) => {
      const start = new Date(firstHour.getTime() + index * 3_600_000);
      return {
        interval: { startTime: start.toISOString(), endTime: new Date(start.getTime() + 3_600_000).toISOString() },
        displayDateTime: { utcOffset: "19800s" },
        weatherCondition: {
          iconBaseUri: "https://maps.gstatic.com/weather/v1/test",
          description: { text: weather.description },
          type: weather.type,
        },
        temperature: { degrees: 28 },
        precipitation: { probability: { percent: weather.rainMm > 0 ? 90 : 0 }, qpf: { quantity: weather.rainMm } },
        thunderstormProbability: 0,
        wind: { gust: { value: 10 } },
        visibility: { distance: 10 },
        iceThickness: { thickness: 0 },
      };
    }),
  };
}

const fetchStub = vi.fn(async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://weather.googleapis.com/")) throw new Error(`Unexpected fetch in test: ${url}`);

  return weatherFails
    ? Response.json({ error: { message: "stubbed failure" } }, { status: 500 })
    : Response.json(forecastResponse(forecast));
});

// Due north along longitude 72.9 near Surat, ~111 km: one point per ~1.1 km.
const PLANNED_PATH: [number, number][] = Array.from({ length: 101 }, (_, index) => [72.9, 21 + index * 0.01]);
// A reroute from halfway, bending east.
const REROUTE_PATH: [number, number][] = Array.from({ length: 51 }, (_, index) => [72.9 + index * 0.004, 21.5 + index * 0.01]);

const createdSessionIds: string[] = [];

async function createSession(status: "PLANNED" | "ACTIVE" = "ACTIVE"): Promise<string> {
  const session = await prisma.trackingSession.create({
    data: {
      status,
      deviceId: status === "ACTIVE" ? "weather-integration-test" : null,
      startedAt: status === "ACTIVE" ? new Date() : null,
      startLatitude: 21,
      startLongitude: 72.9,
      startRadiusMeters: 300,
      destinationLatitude: 22,
      destinationLongitude: 72.9,
      destinationRadiusMeters: 300,
      plannedDistanceMeters: 111_000,
      plannedDurationMinutes: 120,
      plannedRoute: PLANNED_PATH,
    },
    select: { id: true },
  });

  createdSessionIds.push(session.id);
  return session.id;
}

async function sessionRow(sessionId: string) {
  return prisma.trackingSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { weatherVersion: true, weatherRouteVersion: true, weatherCheckedAt: true, weatherError: true, routeWeather: true },
  });
}

const alertCount = (sessionId: string) => prisma.trackingWeatherAlert.count({ where: { sessionId } });

beforeAll(() => {
  vi.stubGlobal("fetch", fetchStub);
  process.env.GOOGLE_MAPS_SERVER_API_KEY = "test-key";
});

beforeEach(() => {
  process.env.GOOGLE_WEATHER_ENABLED = "true";
  forecast = CLEAR;
  weatherFails = false;
  fetchStub.mockClear();
});

afterEach(() => {
  delete process.env.GOOGLE_WEATHER_ENABLED;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.trackingSession.deleteMany({ where: { id: { in: createdSessionIds } } });
});

describe("refreshWeather", () => {
  it("raises an alert for a hazard ahead and moves weatherVersion up", async () => {
    const sessionId = await createSession();
    forecast = HEAVY_RAIN;

    await refreshWeather(sessionId, { force: true });

    const row = await sessionRow(sessionId);
    expect(row.weatherVersion).toBe(1);
    expect(row.weatherRouteVersion).toBe(1);
    expect(row.weatherError).toBeNull();
    expect(fetchStub).toHaveBeenCalled();

    // Rain at every point is one band of rain: one alert, from where it starts.
    const alerts = await prisma.trackingWeatherAlert.findMany({ where: { sessionId } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "HEAVY_RAIN", severity: "WARNING", routeVersion: 1, distanceAheadMeters: 0 });
    expect(alerts[0].message).toMatch(/^Heavy rain \(up to 12 mm\/h\) expected close by around \d\d:\d\d, for about 111 km$/);

    // The phone hears of it in its next locations response.
    const recorded = await recordLocations(sessionId, [
      { id: crypto.randomUUID(), latitude: 21, longitude: 72.9, accuracy: 10, capturedAt: new Date() },
    ]);
    expect(recorded).toMatchObject({ outcome: "recorded", weatherVersion: 1 });
  });

  it("does not raise the same alert twice, and leaves weatherVersion alone", async () => {
    const sessionId = await createSession();
    forecast = HEAVY_RAIN;

    await refreshWeather(sessionId, { force: true });
    const first = await alertCount(sessionId);

    await refreshWeather(sessionId, { force: true });

    expect(await alertCount(sessionId)).toBe(first);
    expect((await sessionRow(sessionId)).weatherVersion).toBe(1);
  });

  it("does not raise the same storm again when the check crosses an hour boundary", async () => {
    const sessionId = await createSession();
    forecast = HEAVY_RAIN;
    // Only Date is faked: the database driver's timers keep running.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-26T07:59:58.000Z"));
      await refreshWeather(sessionId, { force: true });
      const first = await alertCount(sessionId);

      vi.setSystemTime(new Date("2026-10-26T08:00:03.000Z"));
      await refreshWeather(sessionId, { force: true });

      expect(await alertCount(sessionId)).toBe(first);
      expect((await sessionRow(sessionId)).weatherVersion).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("raises it again when it gets worse", async () => {
    const sessionId = await createSession();
    forecast = HEAVY_RAIN;
    await refreshWeather(sessionId, { force: true });
    const first = await alertCount(sessionId);

    forecast = { ...HEAVY_RAIN, rainMm: 40 };
    await refreshWeather(sessionId, { force: true });

    expect(await alertCount(sessionId)).toBeGreaterThan(first);
    expect(await prisma.trackingWeatherAlert.count({ where: { sessionId, severity: "SEVERE" } })).toBeGreaterThan(0);
    expect((await sessionRow(sessionId)).weatherVersion).toBe(2);
  });

  it("finds nothing in clear weather but still stores the check", async () => {
    const sessionId = await createSession();

    await refreshWeather(sessionId, { force: true });

    const row = await sessionRow(sessionId);
    expect(await alertCount(sessionId)).toBe(0);
    // The first check of a route moves the version, so the phone loads the (empty) list.
    expect(row.weatherVersion).toBe(1);
    expect(row.routeWeather).toMatchObject({ routeVersion: 1 });
  });

  it("skips a check that is not due, without calling Google", async () => {
    const sessionId = await createSession();
    await refreshWeather(sessionId, { force: true });
    fetchStub.mockClear();

    await refreshWeather(sessionId);

    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("checks again after a reroute and swaps the phone over to the new route's alerts", async () => {
    const sessionId = await createSession();
    forecast = HEAVY_RAIN;
    await refreshWeather(sessionId, { force: true });

    // What rerouteSession writes, without calling Google Routes.
    await prisma.trackingSession.update({
      where: { id: sessionId },
      data: {
        routeVersion: 2,
        currentRoute: REROUTE_PATH,
        currentRouteDistanceMeters: 60_000,
        currentRouteDurationMinutes: 70,
        reroutedAt: new Date(),
      },
    });
    forecast = CLEAR;

    // Not forced: a newer route than the last check makes it due anyway.
    await refreshWeather(sessionId);

    const row = await sessionRow(sessionId);
    expect(row.weatherVersion).toBe(2);
    expect(row.weatherRouteVersion).toBe(2);

    const { weather } = (await getWeather(sessionId)) as Extract<Awaited<ReturnType<typeof getWeather>>, { outcome: "found" }>;
    expect(weather).toMatchObject({ version: 2, routeVersion: 2 });
    // The old route's rain is not the road ahead any more.
    expect(weather.alerts).toEqual([]);
    expect(weather.checkpoints[0].latitude).toBeCloseTo(21.5);
  });

  it("keeps the last good check when Google fails, and says why", async () => {
    const sessionId = await createSession();
    await refreshWeather(sessionId, { force: true });
    const before = await sessionRow(sessionId);

    weatherFails = true;
    await refreshWeather(sessionId, { force: true });

    const after = await sessionRow(sessionId);
    expect(after.weatherError).toMatch(/HTTP 500: stubbed failure/);
    expect(after.routeWeather).toEqual(before.routeWeather);
    expect(after.weatherVersion).toBe(before.weatherVersion);
  });

  it("does nothing for a session no phone has started", async () => {
    const sessionId = await createSession("PLANNED");

    await refreshWeather(sessionId, { force: true });

    expect(fetchStub).not.toHaveBeenCalled();
    expect((await sessionRow(sessionId)).weatherCheckedAt).toBeNull();
  });

  it("does nothing while GOOGLE_WEATHER_ENABLED is off", async () => {
    const sessionId = await createSession();
    delete process.env.GOOGLE_WEATHER_ENABLED;

    await refreshWeather(sessionId, { force: true });

    expect(fetchStub).not.toHaveBeenCalled();
    expect((await sessionRow(sessionId)).weatherVersion).toBe(0);
  });
});

describe("getWeather and getFeed", () => {
  it("give the phone and the dashboard the same alerts", async () => {
    const sessionId = await createSession();
    forecast = HEAVY_RAIN;
    await refreshWeather(sessionId, { force: true });

    const phone = await getWeather(sessionId);
    const feed = await getFeed(sessionId, null);

    expect(phone.outcome).toBe("found");
    if (phone.outcome !== "found") return;
    expect(phone.weather.alerts.length).toBe(await alertCount(sessionId));
    expect(feed?.weatherAlerts.map((alert) => alert.id)).toEqual(phone.weather.alerts.map((alert) => alert.id));
    expect(feed?.routeWeather?.checkpoints.length).toBe(phone.weather.checkpoints.length);
    expect(feed?.session.weatherVersion).toBe(1);
  });

  it("is not_found for an unknown session", async () => {
    expect(await getWeather(crypto.randomUUID())).toEqual({ outcome: "not_found" });
  });
});
