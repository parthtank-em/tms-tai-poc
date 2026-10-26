"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  GoogleMapsProvider,
  SessionMapView,
  type MapFence,
  type MapLine,
  type MapMarker,
} from "@/components/tracking/session-map-view";
import { TrackingStatusBadge, TripStatusBadge } from "@/components/tracking/tracking-status-badge";
import { HazardBadge, WeatherStrip } from "@/components/tracking/weather";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTimeSeconds, formatNumber } from "@/lib/format";
import {
  arrivalTime,
  endLabel,
  eventLabel,
  formatDistance,
  formatMinutes,
  isMilestone,
  mergeEvents,
  mergeLocations,
  mergeWeatherAlerts,
  wasReplayed,
} from "@/lib/tracking/display";
import type { EventView, LocationView, SessionFeed, WeatherAlertView } from "@/lib/tracking/types";

/**
 * The /tracking session map — a copy of the Radar POC's trip map
 * (src/app/radar-tracking/[tripId]/trip-map.tsx), kept separate so the two POCs
 * can change independently.
 *
 * The dashed line is the route planned on the portal; the solid one is what
 * the phone forwards; the geofence and trip state is what Radar reported by
 * webhook. Radar events carry a position, so the milestones are pinned where
 * they happened.
 *
 * A planned trip polls too, so the page notices when a phone starts it.
 */

const POLL_INTERVAL_MS = 5_000;

const TABLE_ROWS = 25;

const START_COLOR = "#16a34a";
const DESTINATION_COLOR = "#dc2626";
const PLANNED_COLOR = "#64748b";
const REROUTE_COLOR = "#2563eb";
const DRIVEN_COLOR = "#7c3aed";
const WEATHER_WARNING_COLOR = "#d97706";
const WEATHER_SEVERE_COLOR = "#b91c1c";

/** Pin colour per milestone, so the map reads without opening the table. */
function eventColor(event: EventView): string {
  switch (event.type) {
    case "user.exited_geofence":
      return "#f59e0b";
    case "user.entered_geofence":
      return "#059669";
    case "user.approaching_trip_destination":
      return "#f97316";
    case "user.arrived_at_trip_destination":
      return "#dc2626";
    default:
      return "#475569";
  }
}

export function SessionMap({ initial }: { initial: SessionFeed }) {
  const router = useRouter();
  const [trip, setTrip] = useState(initial.session);
  const [locations, setLocations] = useState(initial.locations);
  const [events, setEvents] = useState(initial.events);
  // The latest reroute and the snapped driven line: replaced when a poll brings new ones.
  const [currentPath, setCurrentPath] = useState(initial.currentPath);
  const [drivenPath, setDrivenPath] = useState(initial.drivenPath);
  const [routeWeather, setRouteWeather] = useState(initial.routeWeather);
  const [weatherAlerts, setWeatherAlerts] = useState(initial.weatherAlerts);
  const [lastPolledAt, setLastPolledAt] = useState<Date | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [follow, setFollow] = useState(true);
  const cursor = useRef(initial.cursor);

  const tripId = trip.id;
  const status = trip.status;

  useEffect(() => {
    if (status === "COMPLETED") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    // A timeout chain rather than setInterval: a slow response delays the next
    // poll instead of letting requests pile up behind it.
    const poll = async () => {
      try {
        const query = cursor.current ? `?after=${encodeURIComponent(cursor.current)}` : "";
        const response = await fetch(`/api/tracking/sessions/${tripId}/feed${query}`, {
          cache: "no-store",
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const payload = (await response.json()) as SessionFeed;
        if (cancelled) return;

        cursor.current = payload.cursor ?? cursor.current;
        setTrip(payload.session);
        setLocations((current) => mergeLocations(current, payload.locations));
        setEvents((current) => mergeEvents(current, payload.events));
        if (payload.currentPath) setCurrentPath(payload.currentPath);
        if (payload.drivenPath) setDrivenPath(payload.drivenPath);
        if (payload.routeWeather) setRouteWeather(payload.routeWeather);
        setWeatherAlerts((current) => mergeWeatherAlerts(current, payload.weatherAlerts));
        setLastPolledAt(new Date());
        setPollFailed(false);

        if (payload.session.status !== status) {
          // The header (device, started, ended) and its buttons come from the
          // server render. This effect re-runs for the new status.
          router.refresh();
          return;
        }
      } catch {
        // Keep polling — the next request picks up from the same cursor.
        if (!cancelled) setPollFailed(true);
      }

      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    timer = setTimeout(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tripId, status, router]);

  const active = status === "ACTIVE";
  const last = locations.at(-1);

  // What the map draws: both geofences, the planned and driven routes, and markers.
  const fences: MapFence[] = [
    { key: "start", geofence: trip.start, color: START_COLOR },
    { key: "destination", geofence: trip.destination, color: DESTINATION_COLOR },
  ];

  // The driven line snapped to roads when the Roads API has made one, else the raw points.
  const lines: MapLine[] = [
    {
      key: "driven",
      path:
        drivenPath ??
        locations.map((location): [number, number] => [location.longitude, location.latitude]),
      color: DRIVEN_COLOR,
    },
  ];
  if (initial.plannedPath) {
    lines.push({ key: "planned", path: initial.plannedPath, color: PLANNED_COLOR, dashed: true });
  }
  if (currentPath) {
    lines.push({ key: "reroute", path: currentPath, color: REROUTE_COLOR });
  }

  const markers: MapMarker[] = [
    { key: "start", position: trip.start, color: START_COLOR, text: "Source" },
    { key: "destination", position: trip.destination, color: DESTINATION_COLOR, text: "Destination" },
  ];
  // Radar events where they happened; click one to see what it was.
  for (const event of events) {
    if (!isMilestone(event) || event.latitude === null || event.longitude === null) continue;
    markers.push({
      key: event.id,
      position: { latitude: event.latitude, longitude: event.longitude },
      color: eventColor(event),
      text: `${eventLabel(event)} · ${formatDateTimeSeconds(new Date(event.actualCreatedAt))}`,
    });
  }
  // Weather hazards on the route being followed; an earlier route's are only in the table.
  const currentAlerts = weatherAlerts.filter((alert) => alert.routeVersion === trip.routeVersion);
  for (const alert of currentAlerts) {
    markers.push({
      key: `weather-${alert.id}`,
      position: alert,
      color: alert.severity === "SEVERE" ? WEATHER_SEVERE_COLOR : WEATHER_WARNING_COLOR,
      text: alert.message,
    });
  }
  if (last) {
    markers.push({
      key: "last",
      position: last,
      color: DRIVEN_COLOR,
      text: active ? "Current position" : "Last position",
    });
  }

  const replayedCount = events.filter(wasReplayed).length;
  const arrival = arrivalTime(trip);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="h-[32rem] overflow-hidden rounded-xl border bg-muted">
        <GoogleMapsProvider>
          <SessionMapView
            fences={fences}
            lines={lines}
            markers={markers}
            fitKey={tripId}
            panTo={follow && active ? last : null}
            initialCenter={trip.start}
          />
        </GoogleMapsProvider>
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            Trip
            <TrackingStatusBadge status={status} />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm">
            <Stat label="Source">
              <span className="break-words">{endLabel(trip.start)}</span>
              <span className="block text-xs text-muted-foreground">
                Geofence {formatNumber(trip.start.radiusMeters)} m
              </span>
            </Stat>
            <Stat label="Destination">
              <span className="break-words">{endLabel(trip.destination)}</span>
              <span className="block text-xs text-muted-foreground">
                Geofence {formatNumber(trip.destination.radiusMeters)} m
              </span>
            </Stat>
            <Stat label="Planned route (Google, with traffic)">
              {trip.planned ? (
                <>
                  {formatDistance(trip.planned.distanceMeters)} ·{" "}
                  {formatMinutes(trip.planned.durationMinutes)}
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </Stat>
            {trip.rerouted && (
              <Stat label={`Rerouted (route v${trip.routeVersion})`}>
                {formatDistance(trip.rerouted.distanceMeters)} ·{" "}
                {formatMinutes(trip.rerouted.durationMinutes)}
                <span className="block text-xs text-muted-foreground">
                  From where the driver left the route, at{" "}
                  {formatDateTimeSeconds(trip.reroutedAt ? new Date(trip.reroutedAt) : null)}
                </span>
              </Stat>
            )}

            {status === "PLANNED" ? (
              <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                Waiting for a driver to start this trip from the mobile app. Its geofences are
                created in Radar when they do.
              </p>
            ) : (
              <>
                <Stat label="Radar status">
                  <TripStatusBadge status={trip.tripStatus} />
                </Stat>
                <Stat label="ETA (car)">
                  {trip.eta ? (
                    <>
                      {formatMinutes(trip.eta.minutes)} · {formatDistance(trip.eta.distanceMeters)}
                      <span className="block text-xs text-muted-foreground">
                        Arrival ≈ {formatDateTimeSeconds(arrival)}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Waiting for Radar</span>
                  )}
                </Stat>
                <Stat label="Exited start">
                  {formatDateTimeSeconds(trip.departedAt ? new Date(trip.departedAt) : null)}
                </Stat>
                <Stat label="Arrived">
                  {formatDateTimeSeconds(trip.arrivedAt ? new Date(trip.arrivedAt) : null)}
                </Stat>
                <Stat label="Radar events">
                  {formatNumber(events.length)}
                  {replayedCount > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      {formatNumber(replayedCount)} replayed from offline
                    </span>
                  )}
                </Stat>
                <Stat label="Route points">{formatNumber(locations.length)}</Stat>
                <Stat label="Weather ahead">
                  {currentAlerts.length === 0 ? (
                    routeWeather ? (
                      <span className="text-emerald-700 dark:text-emerald-400">No hazards expected</span>
                    ) : (
                      <span className="text-muted-foreground">Not checked yet</span>
                    )
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {currentAlerts.map((alert) => (
                        <HazardBadge key={alert.id} hazard={alert} />
                      ))}
                    </span>
                  )}
                  {trip.weatherCheckedAt && (
                    <span className="block text-xs text-muted-foreground">
                      Checked {formatDateTimeSeconds(new Date(trip.weatherCheckedAt))}
                    </span>
                  )}
                  {trip.weatherError && (
                    <span className="block whitespace-pre-wrap break-words text-xs text-destructive">
                      {trip.weatherError}
                    </span>
                  )}
                </Stat>
              </>
            )}

            {trip.radarSyncError && (
              <Stat label="Radar sync error">
                <span className="block whitespace-pre-wrap break-words text-xs text-destructive">
                  {trip.radarSyncError}
                </span>
              </Stat>
            )}

            {status !== "COMPLETED" && (
              <Stat label="Last refreshed">
                {lastPolledAt ? formatDateTimeSeconds(lastPolledAt) : "Waiting for first poll…"}
                {pollFailed && (
                  <span className="block text-destructive">Last poll failed — retrying.</span>
                )}
              </Stat>
            )}

            {active && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={follow}
                  onChange={(event) => setFollow(event.target.checked)}
                  className="size-4 accent-primary"
                />
                Follow the current position
              </label>
            )}

            {trip.drivenRouteError && (
              <Stat label="Snap to roads">
                <span className="block whitespace-pre-wrap break-words text-xs text-destructive">
                  {trip.drivenRouteError}
                </span>
                <span className="block text-xs text-muted-foreground">Showing the raw points instead.</span>
              </Stat>
            )}

            <MapLegend
              planned={initial.plannedPath !== null}
              rerouted={currentPath !== null}
              snapped={drivenPath !== null}
            />
          </dl>
        </CardContent>
      </Card>

      {status !== "PLANNED" && (
        <div className="lg:col-span-2">
          <Tabs defaultValue="events">
            <TabsList>
              <TabsTrigger value="events">Radar events ({formatNumber(events.length)})</TabsTrigger>
              <TabsTrigger value="points">Route points ({formatNumber(locations.length)})</TabsTrigger>
              <TabsTrigger value="weather">Weather ({formatNumber(weatherAlerts.length)})</TabsTrigger>
            </TabsList>
            <TabsContent value="events" className="mt-2">
              <EventTable events={events} />
            </TabsContent>
            <TabsContent value="points" className="mt-2">
              <PointTable locations={locations} />
            </TabsContent>
            <TabsContent value="weather" className="mt-2 space-y-3">
              {routeWeather && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    Forecast along route v{routeWeather.routeVersion}, from the driver&apos;s position at{" "}
                    {formatDateTimeSeconds(new Date(routeWeather.checkedAt))}.
                  </p>
                  <WeatherStrip checkpoints={routeWeather.checkpoints} />
                </div>
              )}
              <WeatherAlertTable alerts={weatherAlerts} routeVersion={trip.routeVersion} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function MapLegend({
  planned,
  rerouted,
  snapped,
}: {
  planned: boolean;
  rerouted: boolean;
  snapped: boolean;
}) {
  return (
    <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
      {planned && (
        <p className="flex items-center gap-2">
          <span className="w-5 border-t-2 border-dashed" style={{ borderColor: PLANNED_COLOR }} />
          Planned route
        </p>
      )}
      {rerouted && (
        <p className="flex items-center gap-2">
          <span className="w-5 border-t-[3px]" style={{ borderColor: REROUTE_COLOR }} />
          New route after reroute
        </p>
      )}
      <p className="flex items-center gap-2">
        <span className="w-5 border-t-[3px]" style={{ borderColor: DRIVEN_COLOR }} />
        {snapped ? "Driven route (snapped to roads)" : "Driven route (from the phone)"}
      </p>
    </div>
  );
}

/** Newest first. "Replayed" means Radar processed it well after it happened. */
function EventTable({ events }: { events: EventView[] }) {
  const rows = events.slice(-TABLE_ROWS).reverse();

  return (
    <>
      <Truncated shown={rows.length} total={events.length} noun="events" />

      {rows.length === 0 ? (
        <p className="rounded-xl border p-6 text-sm text-muted-foreground">
          No Radar events yet. They arrive by webhook — check that the webhook URL in the Radar
          dashboard reaches this app.
        </p>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Happened</TableHead>
                <TableHead>Received</TableHead>
                <TableHead className="text-right">Confidence</TableHead>
                <TableHead>Delivery</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((event) => (
                <TableRow key={event.id}>
                  <TableCell>
                    <Badge variant={isMilestone(event) ? "secondary" : "outline"}>
                      {eventLabel(event)}
                    </Badge>
                    <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                      {event.type}
                    </span>
                  </TableCell>
                  <TableCell>{formatDateTimeSeconds(new Date(event.actualCreatedAt))}</TableCell>
                  <TableCell>{formatDateTimeSeconds(new Date(event.receivedAt))}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {event.confidence ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {wasReplayed(event) ? "Replayed (offline)" : "Live"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

function PointTable({ locations }: { locations: LocationView[] }) {
  const rows = locations.slice(-TABLE_ROWS).reverse();

  return (
    <>
      <Truncated shown={rows.length} total={locations.length} noun="points" />

      {rows.length === 0 ? (
        <p className="rounded-xl border p-6 text-sm text-muted-foreground">
          No locations received yet.
        </p>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Captured</TableHead>
                <TableHead>Received</TableHead>
                <TableHead className="text-right">Latitude</TableHead>
                <TableHead className="text-right">Longitude</TableHead>
                <TableHead className="text-right">Accuracy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((location) => (
                <TableRow key={location.id}>
                  <TableCell>{formatDateTimeSeconds(new Date(location.capturedAt))}</TableCell>
                  <TableCell>{formatDateTimeSeconds(new Date(location.receivedAt))}</TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {location.latitude.toFixed(6)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {location.longitude.toFixed(6)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {location.accuracy === null ? "—" : `±${Math.round(location.accuracy)} m`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

/**
 * Every weather alert raised for the session, soonest first. Not yet sent to
 * the driver's phone — this table is where they show for now.
 */
function WeatherAlertTable({ alerts, routeVersion }: { alerts: WeatherAlertView[]; routeVersion: number }) {
  if (alerts.length === 0) {
    return (
      <p className="rounded-xl border p-6 text-sm text-muted-foreground">
        No weather alerts. The road ahead is checked at Start, after a reroute and every 30 minutes
        while the session is active (when GOOGLE_WEATHER_ENABLED is on).
      </p>
    );
  }

  return (
    <div className="rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Hazard</TableHead>
            <TableHead>Message</TableHead>
            <TableHead>Expected</TableHead>
            <TableHead>Raised</TableHead>
            <TableHead className="text-right">Route</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {alerts.map((alert) => (
            <TableRow key={alert.id} className={alert.routeVersion === routeVersion ? undefined : "opacity-60"}>
              <TableCell>
                <HazardBadge hazard={alert} />
              </TableCell>
              <TableCell className="whitespace-normal">
                {alert.message}
                <span className="block text-xs text-muted-foreground">{alert.condition}</span>
              </TableCell>
              <TableCell>{formatDateTimeSeconds(new Date(alert.expectedAt))}</TableCell>
              <TableCell>{formatDateTimeSeconds(new Date(alert.createdAt))}</TableCell>
              <TableCell className="text-right tabular-nums">
                v{alert.routeVersion}
                {alert.routeVersion !== routeVersion && (
                  <span className="block text-xs text-muted-foreground">earlier route</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Truncated({ shown, total, noun }: { shown: number; total: number; noun: string }) {
  if (total <= shown) return null;

  return (
    <p className="mb-2 text-xs text-muted-foreground">
      Showing the latest {shown} of {formatNumber(total)} {noun}.
    </p>
  );
}
