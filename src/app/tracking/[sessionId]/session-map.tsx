"use client";

import "mapbox-gl/dist/mapbox-gl.css";

import type { Feature, FeatureCollection, LineString, Point, Polygon } from "geojson";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Layer, Map, Marker, Popup, Source, useMap } from "react-map-gl/mapbox";
import type { MapMouseEvent } from "react-map-gl/mapbox";

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

const ACCESS_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

const MAP_STYLE =
  process.env.NEXT_PUBLIC_MAPBOX_STYLE_URL || "mapbox://styles/mapbox/streets-v12";

/** How many rows each table under the map shows. */
const TABLE_ROWS = 25;

/** The per-point dot layer — the only one that reacts to the pointer. */
const POINTS_LAYER_ID = "route-points";

/** Close enough for drawing and framing a fence a few kilometres across. */
const METERS_PER_DEGREE_LATITUDE = 111_320;

/** Vertices in the polygon that stands in for the geofence circle. */
const CIRCLE_STEPS = 64;

type LngLat = [longitude: number, latitude: number];
type Coordinates = { latitude: number; longitude: number };

// Mapbox and GeoJSON put longitude first — the reverse of how the data reads.
const toLngLat = (point: Coordinates): LngLat => [point.longitude, point.latitude];

/** The fence's half-extent in degrees: wider in longitude away from the equator. */
function radiusInDegrees(geofence: Geofence) {
  const latitude = geofence.radiusMeters / METERS_PER_DEGREE_LATITUDE;
  const longitude = latitude / Math.cos((geofence.latitude * Math.PI) / 180);
  return { latitude, longitude };
}

/** Mapbox has no metre-radius circle, so the fence is drawn as a polygon. */
function circlePolygon(geofence: Geofence): Feature<Polygon> {
  const radius = radiusInDegrees(geofence);
  const ring: LngLat[] = Array.from({ length: CIRCLE_STEPS }, (_, step) => {
    const angle = (step / CIRCLE_STEPS) * 2 * Math.PI;
    return [
      geofence.longitude + radius.longitude * Math.cos(angle),
      geofence.latitude + radius.latitude * Math.sin(angle),
    ];
  });
  ring.push(ring[0]);

  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}

/** South-west and north-east corners around the route and the fence. */
function boundsOf(locations: LocationView[], geofence: Geofence | null): [LngLat, LngLat] {
  const corners = locations.map(toLngLat);
  if (geofence) {
    const radius = radiusInDegrees(geofence);
    corners.push(
      [geofence.longitude - radius.longitude, geofence.latitude - radius.latitude],
      [geofence.longitude + radius.longitude, geofence.latitude + radius.latitude],
    );
  }

  const longitudes = corners.map(([longitude]) => longitude);
  const latitudes = corners.map(([, latitude]) => latitude);
  return [
    [Math.min(...longitudes), Math.min(...latitudes)],
    [Math.max(...longitudes), Math.max(...latitudes)],
  ];
}

type HoveredPoint = Coordinates & { capturedAt: string };

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

  const first = locations.at(0);
  const last = locations.at(-1);
  const lateCount = locations.filter(arrivedLate).length;
  const center = first ?? geofence;

  // The dots are a map layer, not DOM elements, so their tooltip is a popup
  // driven by what the pointer is over.
  const onMouseMove = (event: MapMouseEvent) => {
    const feature = event.features?.[0];
    if (!feature || feature.geometry.type !== "Point") {
      setHovered(null);
      return;
    }
    const [longitude, latitude] = feature.geometry.coordinates;
    setHovered({ longitude, latitude, capturedAt: String(feature.properties?.capturedAt) });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="h-[32rem] overflow-hidden rounded-xl border bg-muted">
        {ACCESS_TOKEN ? (
          <Map
            mapboxAccessToken={ACCESS_TOKEN}
            mapStyle={MAP_STYLE}
            initialViewState={
              center
                ? { longitude: center.longitude, latitude: center.latitude, zoom: 14 }
                : { longitude: 0, latitude: 20, zoom: 2 }
            }
            interactiveLayerIds={[POINTS_LAYER_ID]}
            cursor={hovered ? "pointer" : undefined}
            onMouseMove={onMouseMove}
            onMouseLeave={() => setHovered(null)}
            style={{ width: "100%", height: "100%" }}
          >
            {geofence && <GeofenceCircle geofence={geofence} />}
            <Route locations={locations} active={status === "ACTIVE"} />
            {hovered && (
              <Popup
                longitude={hovered.longitude}
                latitude={hovered.latitude}
                closeButton={false}
                closeOnClick={false}
                offset={8}
              >
                <span className="text-xs">
                  {formatDateTimeSeconds(new Date(hovered.capturedAt))}
                </span>
              </Popup>
            )}
            <Viewport
              locations={locations}
              geofence={geofence}
              follow={follow && status === "ACTIVE"}
            />
          </Map>
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
  const polygon = useMemo(() => circlePolygon(geofence), [geofence]);

  return (
    <Source id="geofence" type="geojson" data={polygon}>
      <Layer
        id="geofence-fill"
        type="fill"
        paint={{ "fill-color": "#7c3aed", "fill-opacity": 0.12 }}
      />
      <Layer
        id="geofence-outline"
        type="line"
        paint={{ "line-color": "#7c3aed", "line-opacity": 0.9, "line-width": 2 }}
      />
    </Source>
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

  // Both sources stay mounted even when empty, so the layers keep their order
  // (fence, then line, then dots) as points arrive.
  const line = useMemo<FeatureCollection<LineString>>(
    () => ({
      type: "FeatureCollection",
      features:
        locations.length < 2
          ? []
          : [
              {
                type: "Feature",
                properties: {},
                geometry: { type: "LineString", coordinates: locations.map(toLngLat) },
              },
            ],
    }),
    [locations],
  );

  const dots = useMemo<FeatureCollection<Point>>(
    () => ({
      type: "FeatureCollection",
      features: locations.slice(1, -1).map((location) => ({
        type: "Feature",
        properties: { capturedAt: location.capturedAt, late: arrivedLate(location) },
        geometry: { type: "Point", coordinates: toLngLat(location) },
      })),
    }),
    [locations],
  );

  return (
    <>
      <Source id="route-line" type="geojson" data={line}>
        <Layer
          id="route-line"
          type="line"
          layout={{ "line-join": "round", "line-cap": "round" }}
          paint={{ "line-color": "#2563eb", "line-opacity": 0.85, "line-width": 4 }}
        />
      </Source>

      <Source id={POINTS_LAYER_ID} type="geojson" data={dots}>
        <Layer
          id={POINTS_LAYER_ID}
          type="circle"
          paint={{
            "circle-radius": 4,
            "circle-color": ["case", ["get", "late"], "#f59e0b", "#2563eb"],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
          }}
        />
      </Source>

      {first && (
        <Marker {...positionOf(first)} color="#16a34a" style={{ zIndex: 1 }} />
      )}

      {/* Separate keys: a marker picks its element (default pin or children) once, on mount. */}
      {last && last !== first && active && (
        <Marker key="current" {...positionOf(last)} style={{ zIndex: 2 }}>
          <span className="relative flex size-5" title="Current position">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-500 opacity-60" />
            <span className="relative inline-flex size-5 rounded-full border-[3px] border-white bg-blue-600 shadow" />
          </span>
        </Marker>
      )}

      {last && last !== first && !active && (
        <Marker key="end" {...positionOf(last)} color="#dc2626" style={{ zIndex: 2 }} />
      )}
    </>
  );
}

const positionOf = ({ longitude, latitude }: Coordinates) => ({ longitude, latitude });

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
  const { current: map } = useMap();
  const framed = useRef(false);
  const lastId = locations.at(-1)?.id;

  useEffect(() => {
    if (!map || (locations.length === 0 && !geofence)) return;

    if (!framed.current) {
      framed.current = true;

      if (locations.length === 1 && !geofence) {
        map.jumpTo({ center: toLngLat(locations[0]), zoom: 15 });
        return;
      }

      // No animation for the first frame — it should look like the page loaded there.
      map.fitBounds(boundsOf(locations, geofence), { padding: 48, duration: 0 });
      return;
    }

    const last = locations.at(-1);
    if (follow && last) map.panTo(toLngLat(last));
    // Re-run on a new latest point, not on every merge that changed nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, lastId, follow]);

  return null;
}

function MissingKey() {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center text-sm">
      <p className="font-medium">Mapbox is not configured.</p>
      <p className="max-w-sm text-muted-foreground">
        Set <code className="font-mono">NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN</code> in{" "}
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
