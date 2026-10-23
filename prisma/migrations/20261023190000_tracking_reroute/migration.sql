-- Geolocation POC: rerouting and the snapped driven line.
--
-- route_version counts the routes the driver has been given (1 = planned);
-- current_route* hold the latest reroute from Google, replaced by the next one;
-- driven_route* hold the driven points snapped to roads by the Google Roads API.

-- AlterTable
ALTER TABLE "tracking_sessions" ADD COLUMN     "current_route" JSONB,
ADD COLUMN     "current_route_distance_meters" INTEGER,
ADD COLUMN     "current_route_duration_minutes" DOUBLE PRECISION,
ADD COLUMN     "driven_route" JSONB,
ADD COLUMN     "driven_route_error" TEXT,
ADD COLUMN     "driven_route_location_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "driven_route_updated_at" TIMESTAMP(3),
ADD COLUMN     "rerouted_at" TIMESTAMP(3),
ADD COLUMN     "route_version" INTEGER NOT NULL DEFAULT 1;

