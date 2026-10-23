import type { Coordinates } from "./types";

/**
 * How far a position is from a route line — the phone's off-route check
 * (docs/geo-location-tracking-mobile-api.md, "Rerouting"). The simulator uses
 * it the same way the app should.
 *
 * Works on a flat projection around the point: for the few hundred meters an
 * off-route threshold is about, that is accurate to well under a meter.
 */

const METERS_PER_DEGREE_LATITUDE = 111_320;

/** Meters from `point` to the nearest point of `path` (`[longitude, latitude]` pairs). */
export function distanceToPathMeters(point: Coordinates, path: [number, number][]): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY;

  const metersPerDegreeLongitude =
    METERS_PER_DEGREE_LATITUDE * Math.cos((point.latitude * Math.PI) / 180);

  // Each path point in meters, relative to `point`, which sits at (0, 0).
  const toXY = ([longitude, latitude]: [number, number]) => ({
    x: (longitude - point.longitude) * metersPerDegreeLongitude,
    y: (latitude - point.latitude) * METERS_PER_DEGREE_LATITUDE,
  });

  if (path.length === 1) {
    const only = toXY(path[0]);
    return Math.hypot(only.x, only.y);
  }

  let nearest = Number.POSITIVE_INFINITY;

  for (let index = 1; index < path.length; index++) {
    const a = toXY(path[index - 1]);
    const b = toXY(path[index]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;

    // Where the point's foot falls on the segment, clamped to its ends.
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared));
    nearest = Math.min(nearest, Math.hypot(a.x + t * dx, a.y + t * dy));
  }

  return nearest;
}
