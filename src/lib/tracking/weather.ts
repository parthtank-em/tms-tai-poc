import type { ForecastHour } from "./google-weather";
import type {
  Coordinates,
  WeatherCheckpoint,
  WeatherHazard,
  WeatherHazardKind,
  WeatherSeverity,
} from "./types";

/**
 * Weather along a route — which points to ask about, when the driver should be
 * at each, and what in the forecast counts as a hazard. No I/O here: the
 * service fetches the forecasts (google-weather.ts) and stores the result.
 *
 * Works the same for the planned route and a reroute, and from wherever the
 * driver is now: only the road ahead is checked.
 */

/** A point every this far along the route… */
export const CHECKPOINT_SPACING_METERS = 25_000;
/** …but no more points than this, so a long route costs the same as a medium one. */
export const MAX_CHECKPOINTS = 12;

/** Thresholds for the hazards. Ours, not Google's — tune them here. */
export const THRESHOLDS = {
  /** Rain rate, mm in the hour. 7.6 mm/h is the usual "heavy" line. */
  heavyRainMm: 7.6,
  severeRainMm: 25,
  thunderstormPercent: 50,
  severeThunderstormPercent: 80,
  strongGustKmh: 60,
  severeGustKmh: 90,
  lowVisibilityKm: 1,
  severeVisibilityKm: 0.2,
  heatC: 42,
  severeHeatC: 46,
};

export const HAZARD_LABELS: Record<WeatherHazardKind, string> = {
  THUNDERSTORM: "Thunderstorm",
  HEAVY_RAIN: "Heavy rain",
  SNOW_ICE: "Snow or ice",
  STRONG_WIND: "Strong wind",
  LOW_VISIBILITY: "Low visibility",
  EXTREME_HEAT: "Extreme heat",
};

const EARTH_RADIUS_METERS = 6_371_000;

/** Great-circle distance between two `[longitude, latitude]` pairs. */
function haversineMeters([lng1, lat1]: [number, number], [lng2, lat2]: [number, number]): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

/** Where on the route to ask about the weather, and when the driver should be there. */
export type SamplePoint = Coordinates & {
  distanceAheadMeters: number;
  expectedAt: Date;
};

/**
 * Points along `path` (`[longitude, latitude]` pairs) from the vertex nearest
 * `from` — the driver's position, or null for the start of the route — to the
 * end: the first, one every CHECKPOINT_SPACING_METERS (wider on a long route,
 * to stay within MAX_CHECKPOINTS), and always the last.
 *
 * The time at each point spreads the route's `durationMinutes` evenly over its
 * length, from `departAt`. Google's duration already includes traffic, so this
 * is as good an estimate as the route's own ETA.
 */
export function sampleRoute(
  path: [number, number][],
  from: Coordinates | null,
  durationMinutes: number,
  departAt: Date,
): SamplePoint[] {
  if (path.length === 0) return [];

  const cumulative = [0];
  for (let index = 1; index < path.length; index++) {
    cumulative.push(cumulative[index - 1] + haversineMeters(path[index - 1], path[index]));
  }
  const total = cumulative.at(-1)!;

  let startIndex = 0;
  if (from) {
    const here: [number, number] = [from.longitude, from.latitude];
    let nearest = Number.POSITIVE_INFINITY;
    path.forEach((point, index) => {
      const meters = haversineMeters(here, point);
      if (meters < nearest) {
        nearest = meters;
        startIndex = index;
      }
    });
  }

  const startMeters = cumulative[startIndex];
  const remaining = total - startMeters;
  // Minutes per meter of this route; a zero-length route takes no time.
  const pace = total > 0 ? durationMinutes / total : 0;
  const spacing = Math.max(CHECKPOINT_SPACING_METERS, remaining / (MAX_CHECKPOINTS - 1));

  const point = (index: number): SamplePoint => {
    const ahead = cumulative[index] - startMeters;
    return {
      longitude: path[index][0],
      latitude: path[index][1],
      distanceAheadMeters: Math.round(ahead),
      expectedAt: new Date(departAt.getTime() + ahead * pace * 60_000),
    };
  };

  const lastIndex = path.length - 1;
  const points = [point(startIndex)];
  let nextMark = spacing;

  for (let index = startIndex + 1; index < lastIndex; index++) {
    const ahead = cumulative[index] - startMeters;
    // Leave the last stretch to the end point itself.
    if (ahead >= nextMark && remaining - ahead >= spacing / 2) {
      points.push(point(index));
      nextMark = ahead + spacing;
    }
  }
  if (lastIndex > startIndex) points.push(point(lastIndex));

  return points;
}

/** The forecast hour that covers `at`; the first hour if `at` is before it; null past the forecast. */
export function hourAt(hours: ForecastHour[], at: Date): ForecastHour | null {
  if (hours.length === 0) return null;
  if (at < hours[0].startTime) return hours[0];
  return hours.find((hour) => hour.startTime <= at && at < hour.endTime) ?? null;
}

/** What in one forecast hour is a hazard for a driver, with how bad. */
export function assessHour(hour: ForecastHour): WeatherHazard[] {
  const hazards: WeatherHazard[] = [];
  const type = hour.conditionType;
  const add = (kind: WeatherHazardKind, severe: boolean) =>
    hazards.push({ kind, severity: severe ? "SEVERE" : "WARNING" });

  const thunder = hour.thunderstormPercent ?? 0;
  if (type.includes("THUNDER") || thunder >= THRESHOLDS.thunderstormPercent) {
    add("THUNDERSTORM", type === "HEAVY_THUNDERSTORM" || thunder >= THRESHOLDS.severeThunderstormPercent);
  }

  const rain = hour.precipitationMm ?? 0;
  const heavyType = type === "HEAVY_RAIN" || type === "MODERATE_TO_HEAVY_RAIN" || type === "RAIN_PERIODICALLY_HEAVY";
  if (heavyType || rain >= THRESHOLDS.heavyRainMm) {
    add("HEAVY_RAIN", rain >= THRESHOLDS.severeRainMm);
  }

  const ice = hour.iceThicknessMm ?? 0;
  if (type.includes("SNOW") || type.includes("HAIL") || ice > 0) {
    add("SNOW_ICE", ice > 0 || type === "HEAVY_SNOW" || type === "SNOWSTORM");
  }

  const gust = hour.windGustKmh ?? 0;
  if (type === "WINDY" || gust >= THRESHOLDS.strongGustKmh) {
    add("STRONG_WIND", gust >= THRESHOLDS.severeGustKmh);
  }

  if (hour.visibilityKm !== null && hour.visibilityKm < THRESHOLDS.lowVisibilityKm) {
    add("LOW_VISIBILITY", hour.visibilityKm < THRESHOLDS.severeVisibilityKm);
  }

  if (hour.temperatureC !== null && hour.temperatureC >= THRESHOLDS.heatC) {
    add("EXTREME_HEAT", hour.temperatureC >= THRESHOLDS.severeHeatC);
  }

  return hazards;
}

/** One hazard ahead, ready to store as an alert. */
export type AlertDraft = WeatherHazard &
  Coordinates & {
    message: string;
    condition: string;
    distanceAheadMeters: number;
    expectedAt: Date;
    /**
     * The start of the forecast hour it was found in: one alert per kind and
     * hour. Google's hours follow local time (in India they start at :30 UTC).
     */
    expectedHour: Date;
  };

/** A later check finding the same kind of hazard this close in time and place is the same hazard. */
export const REPEAT_WITHIN_MS = 60 * 60_000;
export const REPEAT_WITHIN_METERS = 30_000;

/**
 * Whether `draft` is a hazard already raised: the same kind, within an hour and
 * ~30 km of one in `raised`, and no more severe. A later check samples from
 * where the driver is then, so the same storm turns up at slightly different
 * points and times — without this, an arrival time drifting across an hour
 * would notify the driver of it twice. Getting worse (WARNING → SEVERE) is
 * news, so it is raised again.
 */
export function isRepeat(
  draft: AlertDraft,
  raised: (WeatherHazard & Coordinates & { expectedAt: Date })[],
): boolean {
  return raised.some(
    (alert) =>
      alert.kind === draft.kind &&
      SEVERITY_RANK[alert.severity] >= SEVERITY_RANK[draft.severity] &&
      Math.abs(alert.expectedAt.getTime() - draft.expectedAt.getTime()) <= REPEAT_WITHIN_MS &&
      haversineMeters([alert.longitude, alert.latitude], [draft.longitude, draft.latitude]) <= REPEAT_WITHIN_METERS,
  );
}

/**
 * The figure that made it a hazard, for the message. Over a stretch it is the
 * worst point's, said as a bound: "up to 40 mm/h", or "down to 300 m" for
 * visibility, where lower is worse.
 */
function hazardDetail(kind: WeatherHazardKind, hour: ForecastHour, stretch: boolean): string {
  const bound = stretch ? (kind === "LOW_VISIBILITY" ? "down to " : "up to ") : "";

  switch (kind) {
    case "THUNDERSTORM":
      return hour.thunderstormPercent ? ` (${bound}${Math.round(hour.thunderstormPercent)}% chance)` : "";
    case "HEAVY_RAIN":
      return hour.precipitationMm ? ` (${bound}${Math.round(hour.precipitationMm)} mm/h)` : "";
    case "STRONG_WIND":
      return hour.windGustKmh ? ` (gusts ${bound}${Math.round(hour.windGustKmh)} km/h)` : "";
    case "LOW_VISIBILITY":
      return hour.visibilityKm !== null
        ? hour.visibilityKm < 1
          ? ` (${bound}${Math.round(hour.visibilityKm * 1000)} m)`
          : ` (${bound}${hour.visibilityKm} km)`
        : "";
    case "EXTREME_HEAT":
      return hour.temperatureC !== null ? ` (${bound}${Math.round(hour.temperatureC)}°C)` : "";
    case "SNOW_ICE":
      return "";
  }
}

/** `at` as HH:MM local to the forecast point, rounded to five minutes. */
function localTime(at: Date, utcOffsetSeconds: number): string {
  const fiveMinutes = 5 * 60_000;
  const local = new Date(Math.round((at.getTime() + utcOffsetSeconds * 1000) / fiveMinutes) * fiveMinutes);
  return `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
}

function where(distanceAheadMeters: number): string {
  return distanceAheadMeters < 1000 ? "close by" : `${Math.round(distanceAheadMeters / 1000)} km ahead`;
}

const SEVERITY_RANK: Record<WeatherSeverity, number> = { WARNING: 0, SEVERE: 1 };

/** Consecutive points with the same kind of hazard: one alert, from where it starts. */
type Stretch = {
  kind: WeatherHazardKind;
  start: SamplePoint;
  startHour: ForecastHour;
  /** The worst point's severity and hour — the figure the message quotes. */
  severity: WeatherSeverity;
  worstHour: ForecastHour;
  points: number;
  endMeters: number;
};

function stretchAlert(stretch: Stretch): AlertDraft {
  const { kind, start, startHour, severity, worstHour, points } = stretch;
  const detail = hazardDetail(kind, worstHour, points > 1);
  const length = stretch.endMeters - start.distanceAheadMeters;
  const extent = points > 1 && length >= 1000 ? `, for about ${Math.round(length / 1000)} km` : "";

  return {
    kind,
    severity,
    latitude: start.latitude,
    longitude: start.longitude,
    message: `${HAZARD_LABELS[kind]}${detail} expected ${where(start.distanceAheadMeters)} around ${localTime(start.expectedAt, startHour.utcOffsetSeconds)}${extent}`,
    condition: worstHour.description,
    distanceAheadMeters: start.distanceAheadMeters,
    expectedAt: start.expectedAt,
    expectedHour: startHour.startTime,
  };
}

/**
 * Pairs each sample point with its forecast hour and judges it. Returns what
 * to show along the route, and the alerts: one per stretch of consecutive
 * points with the same kind of hazard, placed where it starts, at the worst
 * severity along it. A band of rain over the whole route is one alert, not one
 * per point or per hour.
 *
 * `forecasts[i]` is the forecast for `points[i]`, or null if it failed; a
 * point without a forecast, or beyond it, is left out (and ends a stretch).
 */
export function buildRouteWeather(
  points: SamplePoint[],
  forecasts: (ForecastHour[] | null)[],
): { checkpoints: WeatherCheckpoint[]; alerts: AlertDraft[] } {
  const checkpoints: WeatherCheckpoint[] = [];
  const alerts: AlertDraft[] = [];
  let open = new Map<WeatherHazardKind, Stretch>();

  const closeAll = () => {
    for (const stretch of open.values()) alerts.push(stretchAlert(stretch));
    open = new Map();
  };

  points.forEach((point, index) => {
    const hours = forecasts[index];
    const hour = hours ? hourAt(hours, point.expectedAt) : null;
    if (!hour) {
      closeAll();
      return;
    }

    const hazards = assessHour(hour);
    checkpoints.push({
      latitude: point.latitude,
      longitude: point.longitude,
      distanceAheadMeters: point.distanceAheadMeters,
      expectedAt: point.expectedAt.toISOString(),
      condition: hour.description,
      iconBaseUri: hour.iconBaseUri,
      temperatureC: hour.temperatureC,
      precipitationPercent: hour.precipitationPercent,
      hazards,
    });

    const next = new Map<WeatherHazardKind, Stretch>();
    for (const hazard of hazards) {
      const stretch = open.get(hazard.kind);
      if (!stretch) {
        next.set(hazard.kind, {
          kind: hazard.kind,
          start: point,
          startHour: hour,
          severity: hazard.severity,
          worstHour: hour,
          points: 1,
          endMeters: point.distanceAheadMeters,
        });
        continue;
      }

      open.delete(hazard.kind);
      const worse = SEVERITY_RANK[hazard.severity] > SEVERITY_RANK[stretch.severity];
      next.set(hazard.kind, {
        ...stretch,
        ...(worse ? { severity: hazard.severity, worstHour: hour } : {}),
        points: stretch.points + 1,
        endMeters: point.distanceAheadMeters,
      });
    }

    // Whatever this point no longer has has ended.
    closeAll();
    open = next;
  });
  closeAll();

  return {
    checkpoints,
    alerts: alerts.sort((a, b) => a.expectedAt.getTime() - b.expectedAt.getTime()),
  };
}
