-- AlterTable
ALTER TABLE "outbound_jobs" ADD COLUMN     "event_id" TEXT;

-- CreateIndex
CREATE INDEX "outbound_jobs_event_id_idx" ON "outbound_jobs"("event_id");

-- AddForeignKey
ALTER TABLE "outbound_jobs" ADD CONSTRAINT "outbound_jobs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "shipment_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
