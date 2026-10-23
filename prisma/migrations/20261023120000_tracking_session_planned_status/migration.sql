-- Geolocation POC: sessions are planned on the web portal before a phone starts them.
--
-- A migration of its own because Postgres will not use a new enum value in the
-- transaction that added it, and the next migration makes it the default.

-- AlterEnum
ALTER TYPE "TrackingSessionStatus" ADD VALUE 'PLANNED' BEFORE 'ACTIVE';
