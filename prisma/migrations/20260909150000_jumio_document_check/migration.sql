-- Document checks: an operator uploads a supporting document (address proof,
-- bank statement) and Jumio verifies it and extracts what it can read.
--
-- The uploaded file is never stored — only its name, type and size.

-- CreateTable
CREATE TABLE "document_checks" (
    "id" TEXT NOT NULL,
    "driver_id" TEXT,
    "jumio_account_id" TEXT,
    "jumio_workflow_id" TEXT,
    "jumio_workflow_key" TEXT,
    "jumio_credential_id" TEXT,
    "requested_type" TEXT NOT NULL,
    "requested_country" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_mime_type" TEXT NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "status" "JumioVerificationStatus" NOT NULL DEFAULT 'INITIATED',
    "decision" "JumioDecision",
    "risk_score" DOUBLE PRECISION,
    "document_type" TEXT,
    "document_sub_type" TEXT,
    "issuer" TEXT,
    "extracted_name" TEXT,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "address_city" TEXT,
    "address_subdivision" TEXT,
    "address_postal_code" TEXT,
    "address_country" TEXT,
    "formatted_address" TEXT,
    "document_number" TEXT,
    "issuing_date" TIMESTAMP(3),
    "expiry_date" TIMESTAMP(3),
    "extracted_data" JSONB,
    "decision_details" JSONB,
    "retrieval_attempts" INTEGER NOT NULL DEFAULT 0,
    "retrieved_at" TIMESTAMP(3),
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_checks_created_at_idx" ON "document_checks"("created_at");

-- CreateIndex
CREATE INDEX "document_checks_driver_id_created_at_idx" ON "document_checks"("driver_id", "created_at");

-- CreateIndex
CREATE INDEX "document_checks_jumio_workflow_id_idx" ON "document_checks"("jumio_workflow_id");

-- AlterTable
ALTER TABLE "jumio_callback_events" ADD COLUMN "document_check_id" TEXT;

-- CreateIndex
CREATE INDEX "jumio_callback_events_document_check_id_idx" ON "jumio_callback_events"("document_check_id");

-- AddForeignKey
ALTER TABLE "document_checks" ADD CONSTRAINT "document_checks_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jumio_callback_events" ADD CONSTRAINT "jumio_callback_events_document_check_id_fkey" FOREIGN KEY ("document_check_id") REFERENCES "document_checks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
