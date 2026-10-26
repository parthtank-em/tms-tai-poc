import type { Coordinates } from "./types";

/**
 * Google's Weather API (hourly forecast) — the weather the driver should meet
 * along the route. Routing does not take weather into account (neither
 * Google's nor Radar's), so this only warns; it never changes the route.
 *
 * Server-side only, with the same key as the Routes API (`getGoogleRoutesKey`).
 * The Cloud project needs the Weather API enabled and the key allowed to call it.
 *
 * Off unless GOOGLE_WEATHER_ENABLED is "true": every check is several billed
 * calls (one per point along the route).
 *
 * @see https://developers.google.com/maps/documentation/weather/hourly-forecast
 */

export function isWeatherEnabled(): boolean {
  return process.env.GOOGLE_WEATHER_ENABLED?.trim().toLowerCase() === "true";
}

const ENDPOINT = "https://weather.googleapis.com/v1/forecast/hours:lookup";
const TIMEOUT_MS = 15_000;

/** The API forecasts at most 240 hours ahead. */
export const MAX_FORECAST_HOURS = 240;

/** One forecast hour, in the units we ask for (metric, the API's default). */
export type ForecastHour = {
  startTime: Date;
  endTime: Date;
  /** The place's offset from UTC, in seconds — to say "around 14:00" in local time. */
  utcOffsetSeconds: number;
  /** Google's condition type, e.g. `HEAVY_RAIN`, `THUNDERSTORM`, `CLEAR`. */
  conditionType: string;
  /** e.g. "Light rain". */
  description: string;
  iconBaseUri: string | null;
  temperatureC: number | null;
  precipitationPercent: number | null;
  /** Expected rain (liquid equivalent) in that hour. */
  precipitationMm: number | null;
  thunderstormPercent: number | null;
  windGustKmh: number | null;
  visibilityKm: number | null;
  iceThicknessMm: number | null;
};

export type ForecastResult = { ok: true; hours: ForecastHour[] } | { ok: false; message: string };

type HoursResponse = {
  forecastHours?: {
    interval?: { startTime?: string; endTime?: string };
    displayDateTime?: { utcOffset?: string };
    weatherCondition?: { iconBaseUri?: string; description?: { text?: string }; type?: string };
    temperature?: { degrees?: number };
    precipitation?: { probability?: { percent?: number }; qpf?: { quantity?: number } };
    thunderstormProbability?: number;
    wind?: { gust?: { value?: number } };
    visibility?: { distance?: number };
    iceThickness?: { thickness?: number };
  }[];
  error?: { message?: string };
};

const numberOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The next `hours` forecast hours at one point, starting with the current hour. */
export async function forecastHours(apiKey: string, point: Coordinates, hours: number): Promise<ForecastResult> {
  const params = new URLSearchParams({
    key: apiKey,
    "location.latitude": String(point.latitude),
    "location.longitude": String(point.longitude),
    hours: String(Math.min(Math.max(1, Math.ceil(hours)), MAX_FORECAST_HOURS)),
    // One page holds them all; without it the API pages by 24.
    pageSize: String(MAX_FORECAST_HOURS),
  });

  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}?${params}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    return { ok: false, message: `Google Weather request failed: ${(error as Error).message}` };
  }

  const json = (await response.json().catch(() => null)) as HoursResponse | null;

  if (!response.ok) {
    const detail = json?.error?.message ?? response.statusText;
    return { ok: false, message: `Google Weather → HTTP ${response.status}: ${detail}` };
  }

  const result: ForecastHour[] = [];
  for (const hour of json?.forecastHours ?? []) {
    const startTime = new Date(hour.interval?.startTime ?? "");
    const endTime = new Date(hour.interval?.endTime ?? "");
    if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) continue;

    result.push({
      startTime,
      endTime,
      // "19800s" for India.
      utcOffsetSeconds: Number.parseFloat(hour.displayDateTime?.utcOffset ?? "") || 0,
      conditionType: hour.weatherCondition?.type ?? "TYPE_UNSPECIFIED",
      description: hour.weatherCondition?.description?.text ?? "Unknown",
      iconBaseUri: hour.weatherCondition?.iconBaseUri ?? null,
      temperatureC: numberOrNull(hour.temperature?.degrees),
      precipitationPercent: numberOrNull(hour.precipitation?.probability?.percent),
      precipitationMm: numberOrNull(hour.precipitation?.qpf?.quantity),
      thunderstormPercent: numberOrNull(hour.thunderstormProbability),
      windGustKmh: numberOrNull(hour.wind?.gust?.value),
      visibilityKm: numberOrNull(hour.visibility?.distance),
      iceThicknessMm: numberOrNull(hour.iceThickness?.thickness),
    });
  }

  if (result.length === 0) return { ok: false, message: "Google Weather returned no forecast for this point." };
  return { ok: true, hours: result };
}
