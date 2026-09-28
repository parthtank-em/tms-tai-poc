-- Geo location tracking POC: one session per press of Start, and every
-- position the device reports within it.
--
-- Location ids come from the device, so a retried offline batch collides on
-- the primary key instead of duplicating rows.

-- CreateEnum
CREATE TYPE "TrackingSessionStatus" AS ENUM ('ACTIVE', 'COMPLETED');

-- CreateTable
CREATE TABLE "tracking_sessions" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "status" "TrackingSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracking_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_locations" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tracking_sessions_device_id_started_at_idx" ON "tracking_sessions"("device_id", "started_at");

-- CreateIndex
CREATE INDEX "tracking_sessions_status_idx" ON "tracking_sessions"("status");

-- CreateIndex
CREATE INDEX "tracking_locations_session_id_captured_at_idx" ON "tracking_locations"("session_id", "captured_at");

-- CreateIndex
CREATE INDEX "tracking_locations_session_id_received_at_idx" ON "tracking_locations"("session_id", "received_at");

-- AddForeignKey
ALTER TABLE "tracking_locations" ADD CONSTRAINT "tracking_locations_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "tracking_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

