-- A tracking session becomes a trip: a start and a destination, each with its
-- own geofence, plus the distance and ETA the phone reports. The phone also
-- sends an updated remaining distance and ETA with each location.
--
-- Existing sessions are kept, not dropped: the single geofence they had was
-- drawn around the start point, so it becomes the start fence and every event
-- recorded against it becomes a START event. Those sessions have no
-- destination, distance or ETA — the API requires them only on new sessions.

-- CreateEnum
CREATE TYPE "GeofenceTarget" AS ENUM ('START', 'DESTINATION');

-- The old fence becomes the start fence.
ALTER TABLE "tracking_sessions" DROP CONSTRAINT "tracking_sessions_geofence_all_or_none";
ALTER TABLE "tracking_sessions" RENAME COLUMN "geofence_latitude" TO "start_latitude";
ALTER TABLE "tracking_sessions" RENAME COLUMN "geofence_longitude" TO "start_longitude";
ALTER TABLE "tracking_sessions" RENAME COLUMN "geofence_radius_meters" TO "start_radius_meters";

-- AlterTable
ALTER TABLE "tracking_sessions" ADD COLUMN     "destination_latitude" DECIMAL(10,7),
ADD COLUMN     "destination_longitude" DECIMAL(10,7),
ADD COLUMN     "destination_radius_meters" INTEGER,
ADD COLUMN     "distance_meters" INTEGER,
ADD COLUMN     "eta" TIMESTAMP(3);

-- Hand-written: Prisma cannot express "all three or none".
ALTER TABLE "tracking_sessions" ADD CONSTRAINT "tracking_sessions_start_all_or_none" CHECK (
    ("start_latitude" IS NULL AND "start_longitude" IS NULL AND "start_radius_meters" IS NULL)
    OR ("start_latitude" IS NOT NULL AND "start_longitude" IS NOT NULL AND "start_radius_meters" > 0)
);
ALTER TABLE "tracking_sessions" ADD CONSTRAINT "tracking_sessions_destination_all_or_none" CHECK (
    ("destination_latitude" IS NULL AND "destination_longitude" IS NULL AND "destination_radius_meters" IS NULL)
    OR ("destination_latitude" IS NOT NULL AND "destination_longitude" IS NOT NULL AND "destination_radius_meters" > 0)
);

-- AlterTable
ALTER TABLE "tracking_locations" ADD COLUMN     "remaining_distance_meters" INTEGER,
ADD COLUMN     "eta" TIMESTAMP(3);

-- Every event so far was against the one fence, now the start fence. The
-- default only backfills those rows; new events must name their target.
ALTER TABLE "tracking_geofence_events" ADD COLUMN "target" "GeofenceTarget" NOT NULL DEFAULT 'START';
ALTER TABLE "tracking_geofence_events" ALTER COLUMN "target" DROP DEFAULT;
