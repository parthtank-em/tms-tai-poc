-- Geolocation POC: the same Radar trip flow as the Radar POC. At Start a Radar
-- trip is created as well as the two fences; its status, live ETA, departure
-- and arrival come back by webhook, and every Radar event is stored in
-- tracking_events (like radar_events). Additive only: the old phone-ETA
-- columns and tracking_geofence_events stay for existing sessions.

-- AlterTable
ALTER TABLE "tracking_sessions" ADD COLUMN     "arrived_at" TIMESTAMP(3),
ADD COLUMN     "departed_at" TIMESTAMP(3),
ADD COLUMN     "eta_distance_meters" INTEGER,
ADD COLUMN     "eta_minutes" DOUBLE PRECISION,
ADD COLUMN     "radar_sync_error" TEXT,
ADD COLUMN     "radar_trip_id" TEXT,
ADD COLUMN     "radar_updated_at" TIMESTAMP(3),
ADD COLUMN     "trip_status" "RadarTripStatus";

-- AlterTable
ALTER TABLE "tracking_locations" ADD COLUMN     "accuracy" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "tracking_events" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "target" "GeofenceTarget",
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "accuracy" DOUBLE PRECISION,
    "confidence" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL,
    "actual_created_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,

    CONSTRAINT "tracking_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tracking_events_session_id_actual_created_at_idx" ON "tracking_events"("session_id", "actual_created_at");

-- CreateIndex
CREATE INDEX "tracking_events_session_id_received_at_idx" ON "tracking_events"("session_id", "received_at");

-- AddForeignKey
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "tracking_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

