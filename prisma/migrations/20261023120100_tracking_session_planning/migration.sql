-- Geolocation POC: sessions are planned on the web portal (route from Google),
-- then started by a phone.
--
-- A planned session has no device and no start time yet, so both become
-- nullable. Existing sessions keep theirs. The addresses and the planned route
-- are new and stay null for sessions created before planning existed.

-- AlterTable
ALTER TABLE "tracking_sessions" ADD COLUMN     "destination_address" TEXT,
ADD COLUMN     "planned_duration_minutes" DOUBLE PRECISION,
ADD COLUMN     "planned_route" JSONB,
ADD COLUMN     "start_address" TEXT,
ALTER COLUMN "device_id" DROP NOT NULL,
ALTER COLUMN "started_at" DROP NOT NULL,
ALTER COLUMN "started_at" DROP DEFAULT,
ALTER COLUMN "status" SET DEFAULT 'PLANNED';

-- CreateIndex
CREATE INDEX "tracking_sessions_created_at_idx" ON "tracking_sessions"("created_at");
