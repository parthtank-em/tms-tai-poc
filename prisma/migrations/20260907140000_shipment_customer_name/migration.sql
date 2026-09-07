-- PublicAPIShipmentDetails.customer.name, which TAI has been sending all along
-- but nothing stored. Nullable, so existing rows are untouched until backfilled.
ALTER TABLE "shipments" ADD COLUMN "customer_name" TEXT;
