-- Geolocation POC cleanup: tracking_sessions / tracking_locations now match the
-- Radar POC's radar_trips / radar_trip_locations column for column, and the
-- pre-Radar leftovers go. Checked before writing this: no session lacked a
-- start or destination, no location carried a phone ETA, and
-- tracking_geofence_events was empty — so nothing is lost.

-- The planned distance keeps its value under the Radar POC's name.
ALTER TABLE "tracking_sessions" RENAME COLUMN "distance_meters" TO "planned_distance_meters";

-- The phone's ETA at Start; the live ETA is Radar's (eta_minutes).
ALTER TABLE "tracking_sessions" DROP COLUMN "eta";

-- Every session is planned with both ends, so they are required, as in radar_trips.
-- The all-or-none CHECKs only existed while they could be missing.
ALTER TABLE "tracking_sessions" DROP CONSTRAINT "tracking_sessions_start_all_or_none";
ALTER TABLE "tracking_sessions" DROP CONSTRAINT "tracking_sessions_destination_all_or_none";
ALTER TABLE "tracking_sessions" ALTER COLUMN "start_latitude" SET NOT NULL,
ALTER COLUMN "start_longitude" SET NOT NULL,
ALTER COLUMN "start_radius_meters" SET NOT NULL,
ALTER COLUMN "destination_latitude" SET NOT NULL,
ALTER COLUMN "destination_longitude" SET NOT NULL,
ALTER COLUMN "destination_radius_meters" SET NOT NULL;

-- The phone's own distance and ETA per point; no longer sent.
ALTER TABLE "tracking_locations" DROP COLUMN "eta",
DROP COLUMN "remaining_distance_meters";

-- Device-reported crossings from before Radar; crossings are tracking_events now.
DROP TABLE "tracking_geofence_events";
DROP TYPE "GeofenceEventType";
