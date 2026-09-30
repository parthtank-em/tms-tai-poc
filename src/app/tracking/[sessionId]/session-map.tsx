"use client";

import {
  AdvancedMarker,
  APIProvider,
  Circle,
  Map,
  Pin,
  Polyline,
  useMap,
} from "@vis.gl/react-google-maps";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { TrackingStatusBadge } from "@/components/tracking/tracking-status-badge";
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
import { arrivedLate, mergeGeofenceEvents, mergeLocations } from "@/lib/tracking/merge";
import type {
  Geofence,
  GeofenceEventView,
  LocationView,
  LocationsResponse,
} from "@/lib/tracking/types";

/**
 * Web-map refresh rate (plan §10). Independent of how often the device sends —
 * that is ~2 minutes; this only decides how quickly a new point shows up.
 */
const POLL_INTERVAL_MS = 5_000;

const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

// Advanced markers need a map id. Google's DEMO_MAP_ID works for development;
// set a real one from the Cloud console for anything longer-lived.
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID";

/** Beyond this, per-point dots cost more in DOM than they add in clarity. */
const MAX_POINT_MARKERS = 300;

/** How many rows each table under the map shows. */
const TABLE_ROWS = 25;

const toLatLng = (point: { latitude: number; longitude: number }) => ({
  lat: point.latitude,
  lng: point.longitude,
});

export function SessionMap({
  initial,
  geofence,
}: {
  initial: LocationsResponse;
  geofence: Geofence | null;
}) {
  const router = useRouter();
  const [locations, setLocations] = useState(initial.locations);
  const [geofenceEvents, setGeofenceEvents] = useState(initial.geofenceEvents);
  const [status, setStatus] = useState(initial.status);
  const [lastPolledAt, setLastPolledAt] = useState<Date | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [follow, setFollow] = useState(true);
  const cursor = useRef(initial.cursor);

  const sessionId = initial.sessionId;

  useEffect(() => {
    if (status !== "ACTIVE") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    // A timeout chain rather than setInterval: a slow response delays the next
    // poll instead of letting requests pile up behind it.
    const poll = async () => {
      try {
        const query = cursor.current ? `?after=${encodeURIComponent(cursor.current)}` : "";
        const response = await fetch(`/api/tracking/sessions/${sessionId}/locations${query}`, {
          cache: "no-store",
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const payload = (await response.json()) as LocationsResponse;
        if (cancelled) return;

        cursor.current = payload.cursor ?? cursor.current;
        setLocations((current) => mergeLocations(current, payload.locations));
        setGeofenceEvents((current) => mergeGeofenceEvents(current, payload.geofenceEvents));
        setLastPolledAt(new Date());
        setPollFailed(false);

        if (payload.status !== "ACTIVE") {
          setStatus(payload.status);
          // The header's "ended" time comes from the server render.
          router.refresh();
          return;
        }
      } catch {
        // Keep polling — a dropped request on a flaky connection is expected,
        // and the next one picks up from the same cursor.
        if (!cancelled) setPollFailed(true);
      }

      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    timer = setTimeout(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, status, router]);

  const first = locations.at(0);
  const last = locations.at(-1);
  const lateCount = locations.filter(arrivedLate).length;
  const center = first ?? geofence;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="h-[32rem] overflow-hidden rounded-xl border bg-muted">
        {API_KEY ? (
          <APIProvider apiKey={API_KEY}>
            <Map
              mapId={MAP_ID}
              defaultCenter={center ? toLatLng(center) : { lat: 20, lng: 0 }}
              defaultZoom={center ? 14 : 2}
              gestureHandling="greedy"
              className="size-full"
            >
              {geofence && <GeofenceCircle geofence={geofence} />}
              <Route locations={locations} active={status === "ACTIVE"} />
              <Viewport
                locations={locations}
                geofence={geofence}
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
            Session
            <TrackingStatusBadge status={status} />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm">
            <Stat label="Points">{formatNumber(locations.length)}</Stat>
            <Stat label="Uploaded while offline">{formatNumber(lateCount)}</Stat>
            <Stat label="First capture">
              {formatDateTimeSeconds(first ? new Date(first.capturedAt) : null)}
            </Stat>
            <Stat label="Latest capture">
              {formatDateTimeSeconds(last ? new Date(last.capturedAt) : null)}
            </Stat>

            {geofence && (
              <Stat label="Geofence">
                <GeofenceStatus events={geofenceEvents} />
                <span className="block text-xs text-muted-foreground">
                  {formatNumber(geofence.radiusMeters)} m radius ·{" "}
                  {formatNumber(geofenceEvents.length)} event(s)
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
        {geofence ? (
          <Tabs defaultValue="points">
            <TabsList>
              <TabsTrigger value="points">
                Location points ({formatNumber(locations.length)})
              </TabsTrigger>
              <TabsTrigger value="geofence-events">
                Geofence events ({formatNumber(geofenceEvents.length)})
              </TabsTrigger>
            </TabsList>
            <TabsContent value="points" className="mt-2">
              <PointTable locations={locations} />
            </TabsContent>
            <TabsContent value="geofence-events" className="mt-2">
              <GeofenceEventTable events={geofenceEvents} />
            </TabsContent>
          </Tabs>
        ) : (
          // No fence, no events — a single tab would only add a click.
          <>
            <h2 className="mb-3 text-sm font-medium">Latest points</h2>
            <PointTable locations={locations} />
          </>
        )}
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

/** The fence the session was created with. Only drawn — never tested against. */
function GeofenceCircle({ geofence }: { geofence: Geofence }) {
  return (
    <Circle
      center={toLatLng(geofence)}
      radius={geofence.radiusMeters}
      strokeColor="#7c3aed"
      strokeOpacity={0.9}
      strokeWeight={2}
      fillColor="#7c3aed"
      fillOpacity={0.12}
      clickable={false}
    />
  );
}

/**
 * The device's latest report, by capture time. Unknown until the first event:
 * the device only reports crossings, so a session that starts inside the fence
 * and never leaves has nothing to show.
 */
function GeofenceStatus({ events }: { events: GeofenceEventView[] }) {
  const latest = events.at(-1);

  if (!latest) return <span className="text-muted-foreground">No events yet</span>;

  return latest.type === "ENTER" ? (
    <span className="font-medium text-emerald-600">Inside</span>
  ) : (
    <span className="font-medium text-amber-600">Outside</span>
  );
}

/** The line, the per-point dots, and the start / current-or-end markers. */
function Route({ locations, active }: { locations: LocationView[]; active: boolean }) {
  const first = locations.at(0);
  const last = locations.at(-1);
  const path = locations.map(toLatLng);

  return (
    <>
      <Polyline path={path} strokeColor="#2563eb" strokeOpacity={0.85} strokeWeight={4} />

      {locations.length <= MAX_POINT_MARKERS &&
        locations.slice(1, -1).map((location) => (
          <AdvancedMarker
            key={location.id}
            position={toLatLng(location)}
            title={formatDateTimeSeconds(new Date(location.capturedAt))}
            anchorPoint={["50%", "50%"]}
          >
            <div
              className={`size-2.5 rounded-full ring-2 ring-white ${arrivedLate(location) ? "bg-amber-500" : "bg-blue-600"}`}
            />
          </AdvancedMarker>
        ))}

      {first && (
        <AdvancedMarker position={toLatLng(first)} title="Start" zIndex={1}>
          <Pin background="#16a34a" borderColor="#15803d" glyphColor="#ffffff" />
        </AdvancedMarker>
      )}

      {last && last !== first && (
        <AdvancedMarker position={toLatLng(last)} title={active ? "Current position" : "End"} zIndex={2}>
          {active ? (
            <span className="relative flex size-5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-500 opacity-60" />
              <span className="relative inline-flex size-5 rounded-full border-[3px] border-white bg-blue-600 shadow" />
            </span>
          ) : (
            <Pin background="#dc2626" borderColor="#b91c1c" glyphColor="#ffffff" />
          )}
        </AdvancedMarker>
      )}
    </>
  );
}

/**
 * Frames the route and the geofence once when either is known, then — only
 * while following — pans to each new current position. It never re-fits after
 * that, so zooming or panning by hand is not undone on the next poll.
 */
function Viewport({
  locations,
  geofence,
  follow,
}: {
  locations: LocationView[];
  geofence: Geofence | null;
  follow: boolean;
}) {
  const map = useMap();
  const framed = useRef(false);
  const lastId = locations.at(-1)?.id;

  useEffect(() => {
    if (!map || (locations.length === 0 && !geofence)) return;

    if (!framed.current) {
      framed.current = true;

      if (locations.length === 1 && !geofence) {
        map.setCenter(toLatLng(locations[0]));
        map.setZoom(15);
        return;
      }

      const bounds = new google.maps.LatLngBounds();
      locations.forEach((location) => bounds.extend(toLatLng(location)));
      if (geofence) {
        // Never attached to the map — only used for its bounds.
        const circleBounds = new google.maps.Circle({
          center: toLatLng(geofence),
          radius: geofence.radiusMeters,
        }).getBounds();
        if (circleBounds) bounds.union(circleBounds);
      }
      map.fitBounds(bounds, 48);
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
        <code className="font-mono">.env</code> and restart the dev server. The points are still
        listed below.
      </p>
    </div>
  );
}

/** Newest capture first, like the point table. "Offline" is the device's own flag. */
function GeofenceEventTable({ events }: { events: GeofenceEventView[] }) {
  const rows = events.slice(-TABLE_ROWS).reverse();

  return (
    <>
      <Truncated shown={rows.length} total={events.length} noun="events" />

      {rows.length === 0 ? (
        <p className="rounded-xl border p-6 text-sm text-muted-foreground">
          The device has not reported entering or leaving the geofence yet.
        </p>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Captured</TableHead>
                <TableHead>Received</TableHead>
                <TableHead>Delivery</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((event) => (
                <TableRow key={event.id}>
                  <TableCell>
                    <Badge variant={event.type === "ENTER" ? "secondary" : "outline"}>
                      {event.type === "ENTER" ? "Entered" : "Exited"}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatDateTimeSeconds(new Date(event.capturedAt))}</TableCell>
                  <TableCell>{formatDateTimeSeconds(new Date(event.receivedAt))}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {event.isOffline ? "Offline upload" : "Live"}
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

/** Newest capture first — the rows a person watching a live session wants. */
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
                <TableHead>Delivery</TableHead>
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
                  <TableCell className="text-muted-foreground">
                    {arrivedLate(location) ? "Offline upload" : "Live"}
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

/** Only rendered when the table is cut short. */
function Truncated({ shown, total, noun }: { shown: number; total: number; noun: string }) {
  if (total <= shown) return null;

  return (
    <p className="mb-2 text-xs text-muted-foreground">
      Showing the latest {shown} of {formatNumber(total)} {noun}.
    </p>
  );
}
