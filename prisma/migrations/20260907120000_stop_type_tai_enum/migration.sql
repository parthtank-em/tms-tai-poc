-- Replace StopType with TAI's own vocabulary
-- (PublicAPIShippingAddress.stopType: First Pickup, Last Drop, Pick, Drop, Both).
--
-- Every value changes name, so Postgres cannot rename in place. Build the new
-- type, cast the column across with an explicit mapping, then swap the names.
-- Written by hand rather than generated so no row is dropped.

CREATE TYPE "StopType_new" AS ENUM ('FIRST_PICKUP', 'LAST_DROP', 'PICK', 'DROP', 'BOTH');

ALTER TABLE "shipment_stops"
  ALTER COLUMN "type" TYPE "StopType_new"
  USING (
    CASE "type"::text
      -- These came from TAI's "First Pickup" / "Last Drop" labels.
      WHEN 'PICKUP' THEN 'FIRST_PICKUP'
      WHEN 'DELIVERY' THEN 'LAST_DROP'
      -- INTERMEDIATE was the old catch-all; a mid-route stop both drops and collects.
      WHEN 'INTERMEDIATE' THEN 'BOTH'
      ELSE 'BOTH'
    END
  )::"StopType_new";

DROP TYPE "StopType";
ALTER TYPE "StopType_new" RENAME TO "StopType";
