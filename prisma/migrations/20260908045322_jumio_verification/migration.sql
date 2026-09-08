-- CreateEnum
CREATE TYPE "JumioVerificationStatus" AS ENUM ('INITIATED', 'ACQUISITION_STARTED', 'ACQUIRED', 'PROCESSING', 'PROCESSED', 'SESSION_EXPIRED', 'TOKEN_EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "JumioDecision" AS ENUM ('PASSED', 'WARNING', 'REJECTED', 'NOT_EXECUTED');

-- CreateTable
CREATE TABLE "driver_verifications" (
    "id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "jumio_account_id" TEXT,
    "jumio_workflow_id" TEXT,
    "jumio_workflow_key" TEXT,
    "status" "JumioVerificationStatus" NOT NULL DEFAULT 'INITIATED',
    "decision" "JumioDecision",
    "risk_score" DOUBLE PRECISION,
    "document_type" TEXT,
    "document_sub_type" TEXT,
    "extracted_first_name" TEXT,
    "extracted_last_name" TEXT,
    "extracted_dob" TIMESTAMP(3),
    "license_number" TEXT,
    "license_expiry" TIMESTAMP(3),
    "issuing_country" TEXT,
    "issuing_state" TEXT,
    "liveness_decision" TEXT,
    "face_match_decision" TEXT,
    "decision_details" JSONB,
    "consent_obtained_at" TIMESTAMP(3),
    "consent_ip" TEXT,
    "consent_country" TEXT,
    "consent_state" TEXT,
    "retrieval_attempts" INTEGER NOT NULL DEFAULT 0,
    "retrieved_at" TIMESTAMP(3),
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jumio_callback_events" (
    "id" TEXT NOT NULL,
    "workflow_execution_id" TEXT NOT NULL,
    "account_id" TEXT,
    "status" TEXT NOT NULL,
    "callback_sent_at" TIMESTAMP(3),
    "payload" JSONB NOT NULL,
    "verification_id" TEXT,
    "matched" BOOLEAN NOT NULL DEFAULT true,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,
    "remote_ip" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jumio_callback_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "driver_verifications_driver_id_created_at_idx" ON "driver_verifications"("driver_id", "created_at");

-- CreateIndex
CREATE INDEX "driver_verifications_jumio_account_id_idx" ON "driver_verifications"("jumio_account_id");

-- CreateIndex
CREATE INDEX "driver_verifications_jumio_workflow_id_idx" ON "driver_verifications"("jumio_workflow_id");

-- CreateIndex
CREATE INDEX "jumio_callback_events_workflow_execution_id_idx" ON "jumio_callback_events"("workflow_execution_id");

-- CreateIndex
CREATE INDEX "jumio_callback_events_received_at_idx" ON "jumio_callback_events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "jumio_callback_events_workflow_execution_id_status_callback_key" ON "jumio_callback_events"("workflow_execution_id", "status", "callback_sent_at");

-- AddForeignKey
ALTER TABLE "driver_verifications" ADD CONSTRAINT "driver_verifications_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jumio_callback_events" ADD CONSTRAINT "jumio_callback_events_verification_id_fkey" FOREIGN KEY ("verification_id") REFERENCES "driver_verifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
