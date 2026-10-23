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
import { useEffect, useState } from "react";

import type { Coordinates, Geofence } from "@/lib/radar/types";

/**
 * A Google map for the Radar POC, used by the trip planner and the trip page.
 *
 * Only the map is Google: the route, geofences and events drawn on it come
 * from Radar.
 */

export type MapFence = { key: string; geofence: Geofence; color: string };

export type MapLine = {
  key: string;
  /** `[longitude, latitude]` pairs, as Radar returns them. */
  path: [number, number][];
  color: string;
  dashed?: boolean;
};

export type MapMarker = {
  key: string;
  position: Coordinates;
  color: string;
  /** Shown in a popup when the marker is clicked. */
  text?: string;
};

type Props = {
  fences?: MapFence[];
  lines?: MapLine[];
  markers?: MapMarker[];
  /** Zoom to fit the fences and lines whenever this changes. */
  fitKey?: string | number;
  /** Move the map here whenever it changes (following a live trip). */
  panTo?: Coordinates | null;
  /** Where the map looks before anything is drawn. */
  initialCenter?: Coordinates;
};

const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

/** Advanced markers need a map ID; Google's demo ID works until a real one is set. */
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID";

/** Surat, where this POC's trips are. */
const DEFAULT_CENTER: Coordinates = { latitude: 21.1702, longitude: 72.8311 };

function toLatLng(point: Coordinates): google.maps.LatLngLiteral {
  return { lat: point.latitude, lng: point.longitude };
}

/** Radar gives `[longitude, latitude]`; Google wants `{ lat, lng }`. */
function pathToLatLng(path: [number, number][]): google.maps.LatLngLiteral[] {
  return path.map(([longitude, latitude]) => ({
    lat: latitude,
    lng: longitude,
  }));
}

/** A dashed line in Google Maps is a hidden line with a repeated dash symbol on it. */
const DASHES: google.maps.IconSequence[] = [
  {
    icon: { path: "M 0,-1 0,1", strokeOpacity: 1, scale: 3 },
    offset: "0",
    repeat: "14px",
  },
];

/**
 * Loads Google Maps once for everything inside it: the map and, on the
 * planner, the address boxes (Google Places). Wrap the page section in it.
 */
export function GoogleMapsProvider({ children }: { children: React.ReactNode }) {
  if (!API_KEY) {
    return (
      <div className="rounded-xl border p-6 text-center text-sm">
        <p className="font-medium">Google Maps is not configured.</p>
        <p className="mt-1 text-muted-foreground">
          Set <code className="font-mono">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> in{" "}
          <code className="font-mono">.env</code> and restart the dev server.
        </p>
      </div>
    );
  }

  return <APIProvider apiKey={API_KEY}>{children}</APIProvider>;
}

/** The map. Must be inside a `GoogleMapsProvider`. */
export function TripMapView({
  fences = [],
  lines = [],
  markers = [],
  fitKey,
  panTo,
  initialCenter,
}: Props) {
  const [openMarker, setOpenMarker] = useState<MapMarker | null>(null);

  return (
    <Map
      mapId={MAP_ID}
      defaultCenter={toLatLng(initialCenter ?? DEFAULT_CENTER)}
      defaultZoom={11}
      gestureHandling="greedy"
      disableDefaultUI
      zoomControl
      style={{ width: "100%", height: "100%" }}
    >
      {fences.map((fence) => (
        <Circle
          key={fence.key}
          center={toLatLng(fence.geofence)}
          radius={fence.geofence.radiusMeters}
          fillColor={fence.color}
          fillOpacity={0.15}
          strokeColor={fence.color}
          strokeOpacity={0.9}
          strokeWeight={2}
          clickable={false}
        />
      ))}

      {lines
        .filter((line) => line.path.length >= 2)
        .map((line) =>
          line.dashed ? (
            <Polyline
              key={line.key}
              path={pathToLatLng(line.path)}
              strokeColor={line.color}
              strokeOpacity={0}
              icons={DASHES}
              clickable={false}
            />
          ) : (
            <Polyline
              key={line.key}
              path={pathToLatLng(line.path)}
              strokeColor={line.color}
              strokeOpacity={0.85}
              strokeWeight={4}
              clickable={false}
            />
          ),
        )}

      {markers.map((marker) => (
        <AdvancedMarker
          key={marker.key}
          position={toLatLng(marker.position)}
          title={marker.text}
          onClick={() => setOpenMarker(marker)}
        >
          <Pin background={marker.color} borderColor="#ffffff" glyphColor="#ffffff" />
        </AdvancedMarker>
      ))}

      {openMarker?.text && (
        <InfoWindow
          position={toLatLng(openMarker.position)}
          pixelOffset={[0, -36]}
          onCloseClick={() => setOpenMarker(null)}
        >
          <span className="text-xs">{openMarker.text}</span>
        </InfoWindow>
      )}

      <FitToShapes fences={fences} lines={lines} fitKey={fitKey} />
      <PanTo position={panTo ?? null} />
    </Map>
  );
}

/** Zooms the map to show every fence and line, each time `fitKey` changes. */
function FitToShapes({
  fences,
  lines,
  fitKey,
}: {
  fences: MapFence[];
  lines: MapLine[];
  fitKey?: string | number;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;

    const bounds = new google.maps.LatLngBounds();

    for (const fence of fences) {
      // A circle's box: its radius in degrees of latitude and longitude.
      const latitudeRadius = fence.geofence.radiusMeters / 111_320;
      const longitudeRadius = latitudeRadius / Math.cos((fence.geofence.latitude * Math.PI) / 180);
      bounds.extend({
        lat: fence.geofence.latitude - latitudeRadius,
        lng: fence.geofence.longitude - longitudeRadius,
      });
      bounds.extend({
        lat: fence.geofence.latitude + latitudeRadius,
        lng: fence.geofence.longitude + longitudeRadius,
      });
    }
    for (const line of lines) {
      for (const point of pathToLatLng(line.path)) bounds.extend(point);
    }

    if (!bounds.isEmpty()) map.fitBounds(bounds, 48);
    // Only when asked to (a new preview, a new trip), not on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitKey]);

  return null;
}

/** Moves the map to a position whenever it changes. */
function PanTo({ position }: { position: Coordinates | null }) {
  const map = useMap();
  const latitude = position?.latitude;
  const longitude = position?.longitude;

  useEffect(() => {
    if (!map || latitude === undefined || longitude === undefined) return;
    map.panTo({ lat: latitude, lng: longitude });
  }, [map, latitude, longitude]);

  return null;
}
