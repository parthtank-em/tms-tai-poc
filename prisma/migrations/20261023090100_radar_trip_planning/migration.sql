-- Radar POC: trips are planned on the web portal, then started by a phone.
--
-- A planned trip has no device and no start time yet, so both become nullable.
-- Existing trips keep theirs. The addresses and the planned route are new and
-- stay null for trips created before planning existed.

-- AlterTable
ALTER TABLE "radar_trips" ADD COLUMN     "destination_address" TEXT,
ADD COLUMN     "planned_distance_meters" INTEGER,
ADD COLUMN     "planned_duration_minutes" DOUBLE PRECISION,
ADD COLUMN     "planned_route" JSONB,
ADD COLUMN     "start_address" TEXT,
ALTER COLUMN "device_id" DROP NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'PLANNED',
ALTER COLUMN "started_at" DROP NOT NULL,
ALTER COLUMN "started_at" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "radar_trips_created_at_idx" ON "radar_trips"("created_at");
