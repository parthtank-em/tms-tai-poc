-- Optional geofence per tracking session, and the ENTER/EXIT events the device
-- reports against it. The server only stores and draws the fence; deciding
-- inside or outside happens on the device.

-- CreateEnum
CREATE TYPE "GeofenceEventType" AS ENUM ('ENTER', 'EXIT');

-- AlterTable
ALTER TABLE "tracking_sessions" ADD COLUMN     "geofence_latitude" DECIMAL(10,7),
ADD COLUMN     "geofence_longitude" DECIMAL(10,7),
ADD COLUMN     "geofence_radius_meters" INTEGER;

-- Hand-written: Prisma cannot express "all three or none".
ALTER TABLE "tracking_sessions" ADD CONSTRAINT "tracking_sessions_geofence_all_or_none" CHECK (
    ("geofence_latitude" IS NULL AND "geofence_longitude" IS NULL AND "geofence_radius_meters" IS NULL)
    OR ("geofence_latitude" IS NOT NULL AND "geofence_longitude" IS NOT NULL AND "geofence_radius_meters" > 0)
);

-- CreateTable
CREATE TABLE "tracking_geofence_events" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "type" "GeofenceEventType" NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "is_offline" BOOLEAN NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_geofence_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tracking_geofence_events_session_id_captured_at_idx" ON "tracking_geofence_events"("session_id", "captured_at");

-- CreateIndex
CREATE INDEX "tracking_geofence_events_session_id_received_at_idx" ON "tracking_geofence_events"("session_id", "received_at");

-- AddForeignKey
ALTER TABLE "tracking_geofence_events" ADD CONSTRAINT "tracking_geofence_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "tracking_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
