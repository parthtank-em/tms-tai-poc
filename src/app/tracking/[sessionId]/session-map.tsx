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
import { formatDistance, latestProgress } from "@/lib/tracking/trip";
import type {
  Geofence,
  GeofenceEventView,
  GeofenceTarget,
  LocationView,
  LocationsResponse,
  SessionView,
} from "@/lib/tracking/types";

/**
 * Web-map refresh rate (plan §10). Independent of how often the device sends —
 * that is ~2 minutes; this only decides how quickly a new point shows up.
 */
const POLL_INTERVAL_MS = 5_000;

const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

/** Advanced markers need a map ID; Google's demo ID works until a real one is set. */
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID";

/** Beyond this, per-point dots cost more in DOM than they add in clarity. */
const MAX_POINT_MARKERS = 300;

/** How many rows each table under the map shows. */
const TABLE_ROWS = 25;

/** Close enough for framing a fence a few kilometres across. */
const METERS_PER_DEGREE_LATITUDE = 111_320;

type Coordinates = { latitude: number; longitude: number };

const toLatLng = ({ latitude, longitude }: Coordinates): google.maps.LatLngLiteral => ({
  lat: latitude,
  lng: longitude,
});

/** The fence's half-extent in degrees: wider in longitude away from the equator. */
function radiusInDegrees(geofence: Geofence) {
  const latitude = geofence.radiusMeters / METERS_PER_DEGREE_LATITUDE;
  const longitude = latitude / Math.cos((geofence.latitude * Math.PI) / 180);
  return { latitude, longitude };
}

/** The box around the route and the fences. */
function boundsOf(locations: LocationView[], fences: Fence[]): google.maps.LatLngBoundsLiteral {
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

type HoveredPoint = Coordinates & { capturedAt: string; eta: string | null };

/** One of the session's two fences, with how it is drawn and labelled. */
type Fence = { target: GeofenceTarget; label: string; color: string; geofence: Geofence };

/**
 * The fences a session has. A session from before trips can lack either, so
 * everything below works from this list rather than assuming two.
 */
function fencesOf(session: Pick<SessionView, "start" | "destination">): Fence[] {
  const fences: Fence[] = [];
  if (session.start) {
    fences.push({ target: "START", label: "Start", color: "#16a34a", geofence: session.start });
  }
  if (session.destination) {
    fences.push({
      target: "DESTINATION",
      label: "Destination",
      color: "#dc2626",
      geofence: session.destination,
    });
  }
  return fences;
}

const TARGET_LABEL: Record<GeofenceTarget, string> = { START: "Start", DESTINATION: "Destination" };

export function SessionMap({
  initial,
  session,
}: {
  initial: LocationsResponse;
  session: SessionView;
}) {
  const router = useRouter();
  const [locations, setLocations] = useState(initial.locations);
  const [geofenceEvents, setGeofenceEvents] = useState(initial.geofenceEvents);
  const [status, setStatus] = useState(initial.status);
  const [lastPolledAt, setLastPolledAt] = useState<Date | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [follow, setFollow] = useState(true);
  const [hovered, setHovered] = useState<HoveredPoint | null>(null);
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

  const fences = useMemo(() => fencesOf(session), [session]);
  const first = locations.at(0);
  const last = locations.at(-1);
  const lateCount = locations.filter(arrivedLate).length;
  const center = first ?? fences.at(0)?.geofence;
  const progress = latestProgress(locations, session);

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
              disableDefaultUI
              zoomControl
              style={{ width: "100%", height: "100%" }}
            >
              {fences.map((fence) => (
                <GeofenceCircle key={fence.target} fence={fence} />
              ))}
              <Route locations={locations} active={status === "ACTIVE"} onHover={setHovered} />
              {session.destination && (
                <AdvancedMarker position={toLatLng(session.destination)} zIndex={1}>
                  <span
                    className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow"
                    title="Destination"
                  >
                    Destination
                  </span>
                </AdvancedMarker>
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
                  {hovered.eta && (
                    <span className="block text-xs text-muted-foreground">
                      ETA {formatDateTimeSeconds(new Date(hovered.eta))}
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

            {(session.distanceMeters !== null || progress.eta !== null) && (
              <>
                <Stat label="Remaining distance">
                  {formatDistance(progress.remainingDistanceMeters)}
                  <span className="block text-xs text-muted-foreground">
                    of {formatDistance(session.distanceMeters)} planned
                  </span>
                </Stat>
                <Stat label="ETA">
                  {formatDateTimeSeconds(progress.eta ? new Date(progress.eta) : null)}
                  <span className="block text-xs text-muted-foreground">
                    {progress.reportedAt
                      ? `Reported at ${formatDateTimeSeconds(new Date(progress.reportedAt))}`
                      : "As planned at Start"}
                  </span>
                </Stat>
              </>
            )}

            {fences.map((fence) => {
              const events = geofenceEvents.filter((event) => event.target === fence.target);
              return (
                <Stat key={fence.target} label={`${fence.label} geofence`}>
                  <GeofenceStatus events={events} />
                  <span className="block text-xs text-muted-foreground">
                    {formatNumber(fence.geofence.radiusMeters)} m radius ·{" "}
                    {formatNumber(events.length)} event(s)
                  </span>
                </Stat>
              );
            })}

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
        {fences.length > 0 ? (
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

/** One of the session's fences. Only drawn — never tested against. */
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

/**
 * The latest crossing, by capture time — reported by Radar, or by the device
 * on sessions from before Radar. Unknown until the first event: only crossings
 * are reported, so a fence the device never enters or leaves has nothing to show.
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
function Route({
  locations,
  active,
  onHover,
}: {
  locations: LocationView[];
  active: boolean;
  onHover: (point: HoveredPoint | null) => void;
}) {
  const first = locations.at(0);
  const last = locations.at(-1);
  const path = useMemo(() => locations.map(toLatLng), [locations]);

  return (
    <>
      <Polyline
        path={path}
        strokeColor="#2563eb"
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
                eta: location.eta,
              })
            }
            onMouseLeave={() => onHover(null)}
          >
            <span
              className={`block size-3 rounded-full border-2 border-white ${arrivedLate(location) ? "bg-amber-500" : "bg-blue-600"}`}
            />
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
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-500 opacity-60" />
            <span className="relative inline-flex size-5 rounded-full border-[3px] border-white bg-blue-600 shadow" />
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
 * Frames the route and the fences once when any is known, then — only while
 * following — pans to each new current position. It never re-fits after that,
 * so zooming or panning by hand is not undone on the next poll.
 */
function Viewport({
  locations,
  fences,
  follow,
}: {
  locations: LocationView[];
  fences: Fence[];
  follow: boolean;
}) {
  const map = useMap();
  const framed = useRef(false);
  const lastId = locations.at(-1)?.id;

  useEffect(() => {
    if (!map || (locations.length === 0 && fences.length === 0)) return;

    if (!framed.current) {
      framed.current = true;

      if (locations.length === 1 && fences.length === 0) {
        map.setCenter(toLatLng(locations[0]));
        map.setZoom(15);
        return;
      }

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
          No geofence entries or exits yet. Radar reports them by webhook — check that the webhook
          URL in the Radar dashboard reaches this app.
        </p>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Geofence</TableHead>
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
                  <TableCell>{TARGET_LABEL[event.target]}</TableCell>
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
                <TableHead className="text-right">Remaining</TableHead>
                <TableHead>ETA</TableHead>
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
                  <TableCell className="text-right tabular-nums">
                    {formatDistance(location.remainingDistanceMeters)}
                  </TableCell>
                  <TableCell>
                    {formatDateTimeSeconds(location.eta ? new Date(location.eta) : null)}
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
