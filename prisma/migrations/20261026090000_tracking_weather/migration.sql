-- Geolocation POC: weather along the route (Google Weather API).
--
-- route_weather / weather_* on the session hold the last check of the road
-- ahead; tracking_weather_alerts holds the hazards found, once per kind and
-- hour on each route version (the unique index makes a repeat check a no-op).
-- weather_version tells the phone when there is something new to fetch.

-- CreateEnum
CREATE TYPE "WeatherHazardKind" AS ENUM ('THUNDERSTORM', 'HEAVY_RAIN', 'SNOW_ICE', 'STRONG_WIND', 'LOW_VISIBILITY', 'EXTREME_HEAT');

-- CreateEnum
CREATE TYPE "WeatherSeverity" AS ENUM ('WARNING', 'SEVERE');

-- AlterTable
ALTER TABLE "tracking_sessions" ADD COLUMN     "route_weather" JSONB,
ADD COLUMN     "weather_checked_at" TIMESTAMP(3),
ADD COLUMN     "weather_error" TEXT,
ADD COLUMN     "weather_route_version" INTEGER,
ADD COLUMN     "weather_version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "tracking_weather_alerts" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "route_version" INTEGER NOT NULL,
    "kind" "WeatherHazardKind" NOT NULL,
    "severity" "WeatherSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "distance_ahead_meters" INTEGER NOT NULL,
    "expected_at" TIMESTAMP(3) NOT NULL,
    "expected_hour" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_weather_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tracking_weather_alerts_session_id_created_at_idx" ON "tracking_weather_alerts"("session_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_weather_alerts_session_id_route_version_kind_expec_key" ON "tracking_weather_alerts"("session_id", "route_version", "kind", "expected_hour");

-- AddForeignKey
ALTER TABLE "tracking_weather_alerts" ADD CONSTRAINT "tracking_weather_alerts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "tracking_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
