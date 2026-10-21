-- Radar geofencing POC (docs/radar-tracking-poc.md). New tables only: nothing
-- in the existing tracking_* tables is read, altered or dropped.

-- CreateEnum
CREATE TYPE "RadarTripLifecycle" AS ENUM ('ACTIVE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "RadarTripStatus" AS ENUM ('PENDING', 'STARTED', 'APPROACHING', 'ARRIVED', 'COMPLETED', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RadarGeofenceTarget" AS ENUM ('START', 'DESTINATION');

-- CreateTable
CREATE TABLE "radar_trips" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "status" "RadarTripLifecycle" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "start_latitude" DECIMAL(10,7) NOT NULL,
    "start_longitude" DECIMAL(10,7) NOT NULL,
    "start_radius_meters" INTEGER NOT NULL,
    "destination_latitude" DECIMAL(10,7) NOT NULL,
    "destination_longitude" DECIMAL(10,7) NOT NULL,
    "destination_radius_meters" INTEGER NOT NULL,
    "radar_trip_id" TEXT,
    "trip_status" "RadarTripStatus",
    "eta_minutes" DOUBLE PRECISION,
    "eta_distance_meters" INTEGER,
    "radar_updated_at" TIMESTAMP(3),
    "departed_at" TIMESTAMP(3),
    "arrived_at" TIMESTAMP(3),
    "radar_sync_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "radar_trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "radar_trip_locations" (
    "id" TEXT NOT NULL,
    "trip_id" TEXT NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "radar_trip_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "radar_events" (
    "id" TEXT NOT NULL,
    "trip_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "target" "RadarGeofenceTarget",
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "accuracy" DOUBLE PRECISION,
    "confidence" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL,
    "actual_created_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,

    CONSTRAINT "radar_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "radar_trips_device_id_started_at_idx" ON "radar_trips"("device_id", "started_at");

-- CreateIndex
CREATE INDEX "radar_trips_status_idx" ON "radar_trips"("status");

-- CreateIndex
CREATE INDEX "radar_trip_locations_trip_id_captured_at_idx" ON "radar_trip_locations"("trip_id", "captured_at");

-- CreateIndex
CREATE INDEX "radar_trip_locations_trip_id_received_at_idx" ON "radar_trip_locations"("trip_id", "received_at");

-- CreateIndex
CREATE INDEX "radar_events_trip_id_actual_created_at_idx" ON "radar_events"("trip_id", "actual_created_at");

-- CreateIndex
CREATE INDEX "radar_events_trip_id_received_at_idx" ON "radar_events"("trip_id", "received_at");

-- AddForeignKey
ALTER TABLE "radar_trip_locations" ADD CONSTRAINT "radar_trip_locations_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "radar_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "radar_events" ADD CONSTRAINT "radar_events_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "radar_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

