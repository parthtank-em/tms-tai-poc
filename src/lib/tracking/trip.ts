import type { LocationView, SessionView } from "./types";

export type TripProgress = {
  remainingDistanceMeters: number | null;
  eta: string | null;
  /** The capture time of the fix the figures came from, or null for the Start values. */
  reportedAt: string | null;
};

/**
 * The phone's latest remaining distance and ETA.
 *
 * "Latest" is by `capturedAt`, not by arrival: an offline batch lands after
 * the live points that followed it, and its stale ETA must not replace a
 * fresher one. Points without figures are skipped. Before any point has them,
 * the values the phone sent at Start stand in.
 *
 * `locations` must be ordered by `capturedAt` ascending, as the API and
 * `mergeLocations` both return them.
 */
export function latestProgress(
  locations: LocationView[],
  session: Pick<SessionView, "distanceMeters" | "eta">,
): TripProgress {
  for (let index = locations.length - 1; index >= 0; index--) {
    const location = locations[index];
    if (location.remainingDistanceMeters !== null || location.eta !== null) {
      return {
        remainingDistanceMeters: location.remainingDistanceMeters,
        eta: location.eta,
        reportedAt: location.capturedAt,
      };
    }
  }

  return { remainingDistanceMeters: session.distanceMeters, eta: session.eta, reportedAt: null };
}

/** `112400` → `112.4 km`, `850` → `850 m`. */
export function formatDistance(meters: number | null | undefined): string {
  if (meters === null || meters === undefined) return "—";
  if (meters < 1_000) return `${meters} m`;

  return `${(meters / 1_000).toLocaleString("en-US", { maximumFractionDigits: 1 })} km`;
}
