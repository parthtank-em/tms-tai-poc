"use client";

import {
  AdvancedMarker,
  APIProvider,
  Circle,
  InfoWindow,
  Map,
  Pin,
  Polyline,
  useMap,
} from "@vis.gl/react-google-maps";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { RadarTripStatusBadge, TripLifecycleBadge } from "@/components/radar-tracking/trip-badges";
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
  eventLabel,
  formatDistance,
  formatMinutes,
  isMilestone,
  mergeEvents,
  mergeLocations,
  wasReplayed,
} from "@/lib/radar/display";
import type {
  Geofence,
  RadarEventView,
  RadarFeed,
  RadarGeofenceTarget,
  RadarLocationView,
} from "@/lib/radar/types";

/**
 * The Radar trip map. Deliberately its own component rather than an import of
 * the /tracking session map, so the two POCs can change independently.
 *
 * The route line is what the phone forwards; the geofence and trip state is
 * what Radar reported by webhook. Radar events carry a position, so the
 * milestones are pinned where they happened.
 */

const POLL_INTERVAL_MS = 5_000;

const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

/** Advanced markers need a map ID; Google's demo ID works until a real one is set. */
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID";

/** Beyond this, per-point dots cost more in DOM than they add in clarity. */
const MAX_POINT_MARKERS = 300;

const TABLE_ROWS = 25;

const METERS_PER_DEGREE_LATITUDE = 111_320;

type Coordinates = { latitude: number; longitude: number };

const toLatLng = ({ latitude, longitude }: Coordinates): google.maps.LatLngLiteral => ({
  lat: latitude,
  lng: longitude,
});

function radiusInDegrees(geofence: Geofence) {
  const latitude = geofence.radiusMeters / METERS_PER_DEGREE_LATITUDE;
  const longitude = latitude / Math.cos((geofence.latitude * Math.PI) / 180);
  return { latitude, longitude };
}

type Fence = { target: RadarGeofenceTarget; label: string; color: string; geofence: Geofence };

function boundsOf(
  locations: RadarLocationView[],
  fences: Fence[],
): google.maps.LatLngBoundsLiteral {
  const latitudes = locations.map((location) => location.latitude);
  const longitudes = locations.map((location) => location.longitude);
  for (const { geofence } of fences) {
    const radius = radiusInDegrees(geofence);
    latitudes.push(geofence.latitude - radius.latitude, geofence.latitude + radius.latitude);
    longitudes.push(geofence.longitude - radius.longitude, geofence.longitude + radius.longitude);
  }

  return {
    south: Math.min(...latitudes),
    west: Math.min(...longitudes),
    north: Math.max(...latitudes),
    east: Math.max(...longitudes),
  };
}

type Hovered = Coordinates & { capturedAt: string; accuracy: number | null };

/** Pin colour per milestone, so the map reads without opening the table. */
function eventColor(event: RadarEventView): string {
  switch (event.type) {
    case "user.exited_geofence":
      return "bg-amber-500";
    case "user.entered_geofence":
      return "bg-emerald-600";
    case "user.approaching_trip_destination":
      return "bg-orange-500";
    case "user.arrived_at_trip_destination":
      return "bg-red-600";
    default:
      return "bg-slate-600";
  }
}

export function TripMap({ initial }: { initial: RadarFeed }) {
  const router = useRouter();
  const [trip, setTrip] = useState(initial.trip);
  const [locations, setLocations] = useState(initial.locations);
  const [events, setEvents] = useState(initial.events);
  const [lastPolledAt, setLastPolledAt] = useState<Date | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [follow, setFollow] = useState(true);
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<RadarEventView | null>(null);
  const cursor = useRef(initial.cursor);

  const tripId = trip.id;
  const status = trip.status;

  useEffect(() => {
    if (status !== "ACTIVE") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    // A timeout chain rather than setInterval: a slow response delays the next
    // poll instead of letting requests pile up behind it.
    const poll = async () => {
      try {
        const query = cursor.current ? `?after=${encodeURIComponent(cursor.current)}` : "";
        const response = await fetch(`/api/radar-tracking/trips/${tripId}/feed${query}`, {
          cache: "no-store",
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const payload = (await response.json()) as RadarFeed;
        if (cancelled) return;

        cursor.current = payload.cursor ?? cursor.current;
        setTrip(payload.trip);
        setLocations((current) => mergeLocations(current, payload.locations));
        setEvents((current) => mergeEvents(current, payload.events));
        setLastPolledAt(new Date());
        setPollFailed(false);

        if (payload.trip.status !== "ACTIVE") {
          // The header's "ended" time comes from the server render.
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

  const fences = useMemo<Fence[]>(
    () => [
      { target: "START", label: "Start", color: "#16a34a", geofence: trip.start },
      { target: "DESTINATION", label: "Destination", color: "#dc2626", geofence: trip.destination },
    ],
    [trip.start, trip.destination],
  );

  const milestones = events.filter(
    (event) => isMilestone(event) && event.latitude !== null && event.longitude !== null,
  );
  const replayedCount = events.filter(wasReplayed).length;
  const center = locations.at(0) ?? trip.start;
  const arrival = arrivalTime(trip);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="h-[32rem] overflow-hidden rounded-xl border bg-muted">
        {API_KEY ? (
          <APIProvider apiKey={API_KEY}>
            <Map
              mapId={MAP_ID}
              defaultCenter={toLatLng(center)}
              defaultZoom={14}
              gestureHandling="greedy"
              disableDefaultUI
              zoomControl
              style={{ width: "100%", height: "100%" }}
            >
              {fences.map((fence) => (
                <GeofenceCircle key={fence.target} fence={fence} />
              ))}
              <Route locations={locations} active={status === "ACTIVE"} onHover={setHovered} />

              <AdvancedMarker position={toLatLng(trip.destination)} zIndex={1}>
                <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">
                  Destination
                </span>
              </AdvancedMarker>

              {milestones.map((event) => (
                <AdvancedMarker
                  key={event.id}
                  position={{ lat: event.latitude!, lng: event.longitude! }}
                  anchorLeft="-50%"
                  anchorTop="-50%"
                  zIndex={3}
                  title={eventLabel(event)}
                  onClick={() => setSelectedEvent(event)}
                >
                  <span
                    className={`block size-3.5 rotate-45 border-2 border-white shadow ${eventColor(event)}`}
                  />
                </AdvancedMarker>
              ))}

              {selectedEvent &&
                selectedEvent.latitude !== null &&
                selectedEvent.longitude !== null && (
                  <InfoWindow
                    position={{ lat: selectedEvent.latitude, lng: selectedEvent.longitude }}
                    pixelOffset={[0, -10]}
                    onCloseClick={() => setSelectedEvent(null)}
                  >
                    <span className="block text-xs font-medium">{eventLabel(selectedEvent)}</span>
                    <span className="block text-xs">
                      {formatDateTimeSeconds(new Date(selectedEvent.actualCreatedAt))}
                    </span>
                    {selectedEvent.confidence !== null && (
                      <span className="block text-xs text-muted-foreground">
                        Confidence {selectedEvent.confidence}/3
                      </span>
                    )}
                  </InfoWindow>
                )}

              {hovered && (
                <InfoWindow
                  position={toLatLng(hovered)}
                  headerDisabled
                  disableAutoPan
                  shouldFocus={false}
                  pixelOffset={[0, -8]}
                >
                  <span className="block text-xs">
                    {formatDateTimeSeconds(new Date(hovered.capturedAt))}
                  </span>
                  {hovered.accuracy !== null && (
                    <span className="block text-xs text-muted-foreground">
                      ±{Math.round(hovered.accuracy)} m
                    </span>
                  )}
                </InfoWindow>
              )}

              <Viewport
                locations={locations}
                fences={fences}
                follow={follow && status === "ACTIVE"}
              />
            </Map>
          </APIProvider>
        ) : (
          <MissingKey />
        )}
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            Trip
            <TripLifecycleBadge status={status} />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm">
            <Stat label="Radar status">
              <RadarTripStatusBadge status={trip.tripStatus} />
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
            <Stat label="Geofences">
              <span className="text-xs text-muted-foreground">
                Start {formatNumber(trip.start.radiusMeters)} m · destination{" "}
                {formatNumber(trip.destination.radiusMeters)} m
              </span>
            </Stat>

            {trip.radarSyncError && (
              <Stat label="Radar sync error">
                <span className="block whitespace-pre-wrap break-words text-xs text-destructive">
                  {trip.radarSyncError}
                </span>
              </Stat>
            )}

            {status === "ACTIVE" && (
              <>
                <Stat label="Last refreshed">
                  {lastPolledAt ? formatDateTimeSeconds(lastPolledAt) : "Waiting for first poll…"}
                  {pollFailed && (
                    <span className="block text-destructive">Last poll failed — retrying.</span>
                  )}
                </Stat>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={follow}
                    onChange={(event) => setFollow(event.target.checked)}
                    className="size-4 accent-primary"
                  />
                  Follow the current position
                </label>
              </>
            )}
          </dl>
        </CardContent>
      </Card>

      <div className="lg:col-span-2">
        <Tabs defaultValue="events">
          <TabsList>
            <TabsTrigger value="events">Radar events ({formatNumber(events.length)})</TabsTrigger>
            <TabsTrigger value="points">Route points ({formatNumber(locations.length)})</TabsTrigger>
          </TabsList>
          <TabsContent value="events" className="mt-2">
            <EventTable events={events} />
          </TabsContent>
          <TabsContent value="points" className="mt-2">
            <PointTable locations={locations} />
          </TabsContent>
        </Tabs>
      </div>
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

function GeofenceCircle({ fence }: { fence: Fence }) {
  return (
    <Circle
      center={toLatLng(fence.geofence)}
      radius={fence.geofence.radiusMeters}
      fillColor={fence.color}
      fillOpacity={0.12}
      strokeColor={fence.color}
      strokeOpacity={0.9}
      strokeWeight={2}
      clickable={false}
      zIndex={1}
    />
  );
}

/** The line, the per-point dots, and the start / current-or-end markers. */
function Route({
  locations,
  active,
  onHover,
}: {
  locations: RadarLocationView[];
  active: boolean;
  onHover: (point: Hovered | null) => void;
}) {
  const first = locations.at(0);
  const last = locations.at(-1);
  const path = useMemo(() => locations.map(toLatLng), [locations]);

  return (
    <>
      <Polyline
        path={path}
        strokeColor="#7c3aed"
        strokeOpacity={0.85}
        strokeWeight={4}
        clickable={false}
        zIndex={2}
      />

      {locations.length <= MAX_POINT_MARKERS &&
        locations.slice(1, -1).map((location) => (
          <AdvancedMarker
            key={location.id}
            position={toLatLng(location)}
            anchorLeft="-50%"
            anchorTop="-50%"
            onMouseEnter={() =>
              onHover({
                latitude: location.latitude,
                longitude: location.longitude,
                capturedAt: location.capturedAt,
                accuracy: location.accuracy,
              })
            }
            onMouseLeave={() => onHover(null)}
          >
            <span className="block size-3 rounded-full border-2 border-white bg-violet-600" />
          </AdvancedMarker>
        ))}

      {first && (
        <AdvancedMarker position={toLatLng(first)} title="Start" zIndex={1}>
          <Pin background="#16a34a" borderColor="#15803d" glyphColor="#ffffff" />
        </AdvancedMarker>
      )}

      {last && last !== first && active && (
        <AdvancedMarker
          key="current"
          position={toLatLng(last)}
          anchorLeft="-50%"
          anchorTop="-50%"
          zIndex={2}
        >
          <span className="relative flex size-5" title="Current position">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-violet-500 opacity-60" />
            <span className="relative inline-flex size-5 rounded-full border-[3px] border-white bg-violet-600 shadow" />
          </span>
        </AdvancedMarker>
      )}

      {last && last !== first && !active && (
        <AdvancedMarker key="end" position={toLatLng(last)} title="End" zIndex={2}>
          <Pin background="#dc2626" borderColor="#b91c1c" glyphColor="#ffffff" />
        </AdvancedMarker>
      )}
    </>
  );
}

/**
 * Frames the route and the fences once, then — only while following — pans to
 * each new current position. Never re-fits, so manual zoom is not undone.
 */
function Viewport({
  locations,
  fences,
  follow,
}: {
  locations: RadarLocationView[];
  fences: Fence[];
  follow: boolean;
}) {
  const map = useMap();
  const framed = useRef(false);
  const lastId = locations.at(-1)?.id;

  useEffect(() => {
    if (!map) return;

    if (!framed.current) {
      framed.current = true;
      map.fitBounds(boundsOf(locations, fences), 48);
      return;
    }

    const last = locations.at(-1);
    if (follow && last) map.panTo(toLatLng(last));
    // Re-run on a new latest point, not on every merge that changed nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, lastId, follow]);

  return null;
}

function MissingKey() {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center text-sm">
      <p className="font-medium">Google Maps is not configured.</p>
      <p className="max-w-sm text-muted-foreground">
        Set <code className="font-mono">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> in{" "}
        <code className="font-mono">.env</code> and restart the dev server. Events and points are
        still listed below.
      </p>
    </div>
  );
}

/** Newest first. "Replayed" means Radar processed it well after it happened. */
function EventTable({ events }: { events: RadarEventView[] }) {
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

function PointTable({ locations }: { locations: RadarLocationView[] }) {
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

function Truncated({ shown, total, noun }: { shown: number; total: number; noun: string }) {
  if (total <= shown) return null;

  return (
    <p className="mb-2 text-xs text-muted-foreground">
      Showing the latest {shown} of {formatNumber(total)} {noun}.
    </p>
  );
}
