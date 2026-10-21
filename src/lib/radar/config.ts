/**
 * Radar configuration, read from the environment on each call so a missing
 * key is reported where it is needed rather than crashing the app at import.
 *
 * See .env.example and docs/radar-tracking-poc.md §4.
 */

const DEFAULT_API_BASE_URL = "https://api.radar.io/v1";

/**
 * Tags of the two geofences each trip creates. The geofence `externalId` is
 * the trip id, so tag + externalId names one fence of one trip. Prefixed so
 * they cannot collide with anything else in the same Radar project.
 */
export const START_GEOFENCE_TAG = "tms-radar-start";
export const DESTINATION_GEOFENCE_TAG = "tms-radar-dest";

/** Radar trips support foot, bike and car; trucks are routed as cars. */
export const TRIP_MODE = "car";

export type RadarConfig = {
  apiBaseUrl: string;
  /** `prj_test_sk_…` — geofence writes and anything else marked "secret". */
  secretKey: string;
  /** `prj_test_pk_…` — trip create and update, which Radar marks "publishable". */
  publishableKey: string;
};

function env(name: string): string | null {
  return process.env[name]?.trim() || null;
}

/** Null when either key is missing; callers report "not configured". */
export function getRadarConfig(): RadarConfig | null {
  const secretKey = env("RADAR_SECRET_KEY");
  const publishableKey = env("NEXT_PUBLIC_RADAR_PUBLISHABLE_KEY");

  if (!secretKey || !publishableKey) return null;

  return {
    apiBaseUrl: (env("RADAR_API_BASE_URL") ?? DEFAULT_API_BASE_URL).replace(/\/+$/, ""),
    secretKey,
    publishableKey,
  };
}

/** The webhook's security token from the Radar dashboard, or null if unset. */
export function getRadarWebhookToken(): string | null {
  return env("RADAR_WEBHOOK_TOKEN");
}
