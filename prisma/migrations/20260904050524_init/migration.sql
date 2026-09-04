-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('QUOTE', 'COMMITTED', 'READY', 'SENT', 'DISPATCHED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETE', 'CANCELED');

-- CreateEnum
CREATE TYPE "StopType" AS ENUM ('PICKUP', 'DELIVERY', 'INTERMEDIATE');

-- CreateEnum
CREATE TYPE "EventSource" AS ENUM ('TAI_WEBHOOK', 'TAI_API', 'FREIGHTID_INTERNAL');

-- CreateEnum
CREATE TYPE "ShipmentEventType" AS ENUM ('SHIPMENT_CREATED', 'SHIPMENT_DETAILS_UPDATED', 'SHIPMENT_STATUS_UPDATED', 'DRIVER_ASSIGNED', 'DRIVER_IDENTITY_VERIFIED', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED_AT_DELIVERY', 'DELIVERED', 'POD_CAPTURED', 'LOCATION_UPDATED', 'SECURITY_ALERT_RAISED', 'SECURITY_ALERT_RESOLVED');

-- CreateEnum
CREATE TYPE "TaiSyncStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'SYNCED', 'FAILED', 'HELD');

-- CreateEnum
CREATE TYPE "DriverVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "WebhookType" AS ENUM ('SHIPMENT_CREATE', 'SHIPMENT_DETAIL_UPDATE', 'SHIPMENT_STATUS_UPDATE', 'SHIPMENT_LOCATION_UPDATE', 'OTHER');

-- CreateEnum
CREATE TYPE "WebhookAuthResult" AS ENUM ('AUTHORIZED', 'UNAUTHORIZED', 'MALFORMED');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AlertAction" AS ENUM ('CREATE', 'RESOLVE');

-- CreateEnum
CREATE TYPE "OutboundJobStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER');

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "tai_shipment_id" INTEGER,
    "shipment_type" TEXT,
    "service_level" TEXT,
    "status" "ShipmentStatus" NOT NULL,
    "tai_status_label" TEXT,
    "mileage" DECIMAL(10,2),
    "pro_number" TEXT,
    "bol_number" TEXT,
    "po_number" TEXT,
    "shipper_reference" TEXT,
    "load_description" TEXT,
    "load_quantity" INTEGER,
    "load_pieces" INTEGER,
    "load_weight_lb" DECIMAL(10,2),
    "load_hazmat" BOOLEAN NOT NULL DEFAULT false,
    "load_dimensions" JSONB,
    "carrier_name" TEXT,
    "carrier_mc_number" TEXT,
    "carrier_scac" TEXT,
    "carrier_phone" TEXT,
    "driver_id" TEXT,
    "driver_assigned_at" TIMESTAMP(3),
    "driver_identity_verified_at" TIMESTAMP(3),
    "secondary_driver_name" TEXT,
    "secondary_driver_phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "tai_last_seen_at" TIMESTAMP(3),

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_stops" (
    "id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "tai_shipment_stop_id" INTEGER,
    "type" "StopType" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "company_name" TEXT,
    "address1" TEXT,
    "address2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "country" TEXT,
    "window_start" TIMESTAMP(3),
    "window_end" TIMESTAMP(3),
    "appointment_time" TIMESTAMP(3),
    "actual_arrival_at" TIMESTAMP(3),
    "actual_departure_at" TIMESTAMP(3),
    "pod_signed_by" TEXT,
    "pod_arrival_at" TIMESTAMP(3),
    "pod_departure_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipment_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drivers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "license_number" TEXT,
    "license_state" TEXT,
    "verification_status" "DriverVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verified_at" TIMESTAMP(3),
    "verification_detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_events" (
    "id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "stop_id" TEXT,
    "type" "ShipmentEventType" NOT NULL,
    "source" "EventSource" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "details" JSONB,
    "tai_sync_status" "TaiSyncStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "tai_synced_at" TIMESTAMP(3),
    "tai_sync_error" TEXT,
    "webhook_event_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_alerts" (
    "id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "tai_alert_id" INTEGER,
    "alert_type" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "stop_id" TEXT,
    "tai_shipment_stop_id" INTEGER,
    "tai_created_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipment_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'TAI',
    "type" "WebhookType" NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "headers" JSONB,
    "remote_ip" TEXT,
    "auth_result" "WebhookAuthResult" NOT NULL,
    "processing_status" "WebhookProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "response_status" INTEGER,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "tai_shipment_id" INTEGER,
    "shipment_id" TEXT,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_locations" (
    "id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "city" TEXT,
    "state" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "source" "EventSource" NOT NULL DEFAULT 'TAI_WEBHOOK',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_jobs" (
    "id" TEXT NOT NULL,
    "shipment_id" TEXT,
    "operation" TEXT NOT NULL,
    "alert_action" "AlertAction",
    "alert_types" TEXT[],
    "alert_id" TEXT,
    "payload" JSONB NOT NULL,
    "status" "OutboundJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "last_error" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbound_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tai_api_calls" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "request_body" JSONB,
    "response_status" INTEGER,
    "response_body" JSONB,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "duration_ms" INTEGER,
    "job_id" TEXT,
    "shipment_id" TEXT,
    "event_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tai_api_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_tai_shipment_id_key" ON "shipments"("tai_shipment_id");

-- CreateIndex
CREATE INDEX "shipments_status_idx" ON "shipments"("status");

-- CreateIndex
CREATE INDEX "shipments_updated_at_idx" ON "shipments"("updated_at");

-- CreateIndex
CREATE INDEX "shipments_driver_id_idx" ON "shipments"("driver_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_stops_tai_shipment_stop_id_key" ON "shipment_stops"("tai_shipment_stop_id");

-- CreateIndex
CREATE INDEX "shipment_stops_shipment_id_type_idx" ON "shipment_stops"("shipment_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_stops_shipment_id_sequence_key" ON "shipment_stops"("shipment_id", "sequence");

-- CreateIndex
CREATE INDEX "drivers_name_idx" ON "drivers"("name");

-- CreateIndex
CREATE INDEX "shipment_events_shipment_id_occurred_at_idx" ON "shipment_events"("shipment_id", "occurred_at");

-- CreateIndex
CREATE INDEX "shipment_events_type_occurred_at_idx" ON "shipment_events"("type", "occurred_at");

-- CreateIndex
CREATE INDEX "shipment_events_tai_sync_status_idx" ON "shipment_events"("tai_sync_status");

-- CreateIndex
CREATE INDEX "shipment_events_stop_id_idx" ON "shipment_events"("stop_id");

-- CreateIndex
CREATE INDEX "shipment_events_webhook_event_id_idx" ON "shipment_events"("webhook_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_alerts_tai_alert_id_key" ON "shipment_alerts"("tai_alert_id");

-- CreateIndex
CREATE INDEX "shipment_alerts_shipment_id_resolved_idx" ON "shipment_alerts"("shipment_id", "resolved");

-- CreateIndex
CREATE INDEX "shipment_alerts_stop_id_idx" ON "shipment_alerts"("stop_id");

-- CreateIndex
CREATE INDEX "webhook_events_processing_status_received_at_idx" ON "webhook_events"("processing_status", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_type_received_at_idx" ON "webhook_events"("type", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_tai_shipment_id_idx" ON "webhook_events"("tai_shipment_id");

-- CreateIndex
CREATE INDEX "webhook_events_shipment_id_idx" ON "webhook_events"("shipment_id");

-- CreateIndex
CREATE INDEX "shipment_locations_shipment_id_recorded_at_idx" ON "shipment_locations"("shipment_id", "recorded_at");

-- CreateIndex
CREATE INDEX "outbound_jobs_status_next_attempt_at_idx" ON "outbound_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "outbound_jobs_shipment_id_status_idx" ON "outbound_jobs"("shipment_id", "status");

-- CreateIndex
CREATE INDEX "outbound_jobs_alert_id_idx" ON "outbound_jobs"("alert_id");

-- CreateIndex
CREATE INDEX "tai_api_calls_endpoint_created_at_idx" ON "tai_api_calls"("endpoint", "created_at");

-- CreateIndex
CREATE INDEX "tai_api_calls_shipment_id_created_at_idx" ON "tai_api_calls"("shipment_id", "created_at");

-- CreateIndex
CREATE INDEX "tai_api_calls_job_id_idx" ON "tai_api_calls"("job_id");

-- CreateIndex
CREATE INDEX "tai_api_calls_event_id_idx" ON "tai_api_calls"("event_id");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_stops" ADD CONSTRAINT "shipment_stops_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_stop_id_fkey" FOREIGN KEY ("stop_id") REFERENCES "shipment_stops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_webhook_event_id_fkey" FOREIGN KEY ("webhook_event_id") REFERENCES "webhook_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_alerts" ADD CONSTRAINT "shipment_alerts_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_alerts" ADD CONSTRAINT "shipment_alerts_stop_id_fkey" FOREIGN KEY ("stop_id") REFERENCES "shipment_stops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_locations" ADD CONSTRAINT "shipment_locations_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_jobs" ADD CONSTRAINT "outbound_jobs_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_jobs" ADD CONSTRAINT "outbound_jobs_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "shipment_alerts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tai_api_calls" ADD CONSTRAINT "tai_api_calls_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "outbound_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tai_api_calls" ADD CONSTRAINT "tai_api_calls_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tai_api_calls" ADD CONSTRAINT "tai_api_calls_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "shipment_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
