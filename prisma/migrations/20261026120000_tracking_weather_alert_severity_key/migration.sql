-- Geolocation POC: a weather alert that gets worse (WARNING -> SEVERE) in the
-- same forecast hour is a new alert. Severity joins the unique key, which
-- otherwise dropped it as a duplicate of the earlier warning.

-- DropIndex
DROP INDEX "tracking_weather_alerts_session_id_route_version_kind_expec_key";

-- CreateIndex
CREATE UNIQUE INDEX "tracking_weather_alerts_session_id_route_version_kind_sever_key" ON "tracking_weather_alerts"("session_id", "route_version", "kind", "severity", "expected_hour");
