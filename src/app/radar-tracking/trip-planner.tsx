"use client";

import { useMapsLibrary } from "@vis.gl/react-google-maps";
import { EyeIcon, LoaderCircleIcon, MapPinIcon, SaveIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  createTripAction,
  previewRouteAction,
  updateTripAction,
} from "./actions";

import {
  GoogleMapsProvider,
  TripMapView,
  type MapFence,
  type MapLine,
  type MapMarker,
} from "@/components/radar-tracking/trip-map-view";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime } from "@/lib/format";
import { formatDistance, formatMinutes } from "@/lib/radar/display";
import type { RoutePreview, TripEnd } from "@/lib/radar/types";
import {
  MAX_GEOFENCE_RADIUS_METERS,
  MIN_GEOFENCE_RADIUS_METERS,
  type PlanTripInput,
} from "@/lib/radar/validation";

/**
 * The trip planner: source and destination on the left — each picked from
 * Google's address suggestions or typed as coordinates — with the fence radius
 * for each, Preview and Save, and the route figures; the Google map on the
 * right.
 *
 * Preview draws what the server would save, from Radar's route. Save does not
 * depend on it: the server routes the trip again, so a trip is never stored
 * with figures for points other than its own.
 */

type Mode = "address" | "coordinates";

/** One end as the form holds it: text inputs, so a half-typed number stays as typed. */
type EndDraft = {
  mode: Mode;
  /** The picked suggestion's address, or null until one is picked. */
  address: string | null;
  query: string;
  latitude: string;
  longitude: string;
  radius: string;
};

const DEFAULT_RADIUS_METERS = 300;

const SOURCE_COLOR = "#16a34a";
const DESTINATION_COLOR = "#dc2626";
const ROUTE_COLOR = "#2563eb";

/** Wait this long after the last keystroke before asking Radar. */
const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 3;

function emptyEnd(): EndDraft {
  return {
    mode: "address",
    address: null,
    query: "",
    latitude: "",
    longitude: "",
    radius: String(DEFAULT_RADIUS_METERS),
  };
}

function draftOf(end: TripEnd): EndDraft {
  return {
    mode: end.address ? "address" : "coordinates",
    address: end.address,
    query: end.address ?? "",
    latitude: String(end.latitude),
    longitude: String(end.longitude),
    radius: String(end.radiusMeters),
  };
}

/** A blank field is "missing", not zero: `Number("")` would put the point off Africa. */
function numberOf(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

/**
 * The draft as the server's input, or a message naming what is missing.
 * The server checks again; this is only so the user hears it before a round trip.
 */
function toEnd(
  draft: EndDraft,
  name: string,
): { ok: true; end: TripEnd } | { ok: false; error: string } {
  const latitude = numberOf(draft.latitude);
  const longitude = numberOf(draft.longitude);
  const radiusMeters = numberOf(draft.radius);

  if (draft.mode === "address" && draft.address === null) {
    return {
      ok: false,
      error: `Pick a ${name} address from the suggestions, or switch to coordinates.`,
    };
  }
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) {
    return {
      ok: false,
      error: `${name[0].toUpperCase()}${name.slice(1)} latitude must be between -90 and 90.`,
    };
  }
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    return {
      ok: false,
      error: `${name[0].toUpperCase()}${name.slice(1)} longitude must be between -180 and 180.`,
    };
  }
  if (
    !Number.isInteger(radiusMeters) ||
    radiusMeters < MIN_GEOFENCE_RADIUS_METERS ||
    radiusMeters > MAX_GEOFENCE_RADIUS_METERS
  ) {
    return {
      ok: false,
      error: `The ${name} geofence radius must be a whole number of meters between ${MIN_GEOFENCE_RADIUS_METERS} and ${MAX_GEOFENCE_RADIUS_METERS.toLocaleString("en-US")}.`,
    };
  }

  return {
    ok: true,
    end: {
      address: draft.mode === "address" ? draft.address : null,
      latitude,
      longitude,
      radiusMeters,
    },
  };
}

function toInput(
  source: EndDraft,
  destination: EndDraft,
): { ok: true; input: PlanTripInput } | { ok: false; error: string } {
  const start = toEnd(source, "source");
  if (!start.ok) return start;

  const end = toEnd(destination, "destination");
  if (!end.ok) return end;

  return { ok: true, input: { start: start.end, destination: end.end } };
}

/** `at` is when Preview was pressed; null for the saved route an edit opens on. */
type Preview = { input: PlanTripInput; route: RoutePreview; at: number | null };

export type PlannerTrip = {
  id: string;
  start: TripEnd;
  destination: TripEnd;
  route: RoutePreview | null;
};

/** Without `trip`, plans a new trip; with it, edits that planned trip. */
export function TripPlanner({ trip }: { trip?: PlannerTrip }) {
  const router = useRouter();
  const [source, setSource] = useState<EndDraft>(() =>
    trip ? draftOf(trip.start) : emptyEnd(),
  );
  const [destination, setDestination] = useState<EndDraft>(() =>
    trip ? draftOf(trip.destination) : emptyEnd(),
  );

  // Editing opens on the saved route, so the map is not blank until Preview.
  const [preview, setPreview] = useState<Preview | null>(() =>
    trip?.route
      ? {
          input: { start: trip.start, destination: trip.destination },
          route: trip.route,
          at: null,
        }
      : null,
  );
  const [previewCount, setPreviewCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [previewing, startPreview] = useTransition();
  const [saving, startSave] = useTransition();

  const current = toInput(source, destination);
  const stale =
    preview !== null &&
    (!current.ok ||
      JSON.stringify(current.input) !== JSON.stringify(preview.input));

  function runPreview() {
    if (!current.ok) {
      setError(current.error);
      return;
    }

    const input = current.input;
    setError(null);
    startPreview(async () => {
      try {
        const result = await previewRouteAction(input);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setPreview({ input, route: result.route, at: Date.now() });
        setPreviewCount((count) => count + 1);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Preview failed.");
      }
    });
  }

  function save() {
    if (!current.ok) {
      setError(current.error);
      return;
    }

    const input = current.input;
    setError(null);
    startSave(async () => {
      try {
        const result = trip
          ? await updateTripAction(trip.id, input)
          : await createTripAction(input);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.push(`/radar-tracking/${result.tripId}`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Saving failed.");
      }
    });
  }

  const shown = preview?.input;
  const { fences, markers, lines } = useMemo(() => {
    if (!shown || !preview) return { fences: [], markers: [], lines: [] };

    return {
      fences: [
        { key: "source", geofence: shown.start, color: SOURCE_COLOR },
        {
          key: "destination",
          geofence: shown.destination,
          color: DESTINATION_COLOR,
        },
      ] satisfies MapFence[],
      markers: [
        {
          key: "source",
          position: shown.start,
          color: SOURCE_COLOR,
          text: "Source",
        },
        {
          key: "destination",
          position: shown.destination,
          color: DESTINATION_COLOR,
          text: "Destination",
        },
      ] satisfies MapMarker[],
      lines: [
        { key: "route", path: preview.route.path, color: ROUTE_COLOR },
      ] satisfies MapLine[],
    };
  }, [shown, preview]);

  const busy = previewing || saving;

  return (
    <GoogleMapsProvider>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_1fr]">
        <div className="space-y-4">
          <EndCard
            title="Source"
            color={SOURCE_COLOR}
            value={source}
            onChange={setSource}
            disabled={busy}
          />
          <EndCard
            title="Destination"
            color={DESTINATION_COLOR}
            value={destination}
            onChange={setDestination}
            disabled={busy}
          />

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={runPreview} disabled={busy}>
              {previewing ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <EyeIcon />
              )}
              Preview
            </Button>
            <Button onClick={save} disabled={busy}>
              {saving ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <SaveIcon />
              )}
              {trip ? "Save changes" : "Submit"}
            </Button>
            <Button
              variant="ghost"
              render={
                <Link
                  href={trip ? `/radar-tracking/${trip.id}` : "/radar-tracking"}
                />
              }
            >
              Cancel
            </Button>
          </div>

          <RouteCard preview={preview} stale={stale} />
        </div>

        <div className="h-[28rem] overflow-hidden rounded-xl border bg-muted lg:sticky lg:top-6 lg:h-[calc(100svh-8rem)] lg:min-h-[32rem]">
          <TripMapView
            fences={fences}
            markers={markers}
            lines={lines}
            fitKey={previewCount}
          />
        </div>
      </div>
    </GoogleMapsProvider>
  );
}

function RouteCard({
  preview,
  stale,
}: {
  preview: Preview | null;
  stale: boolean;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Route</CardTitle>
        <CardDescription>
          {preview
            ? "Radar's truck route between the two points."
            : "Preview to see the route, distance and ETA."}
        </CardDescription>
      </CardHeader>
      {preview && (
        <CardContent className="space-y-3">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Distance</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums">
                {formatDistance(preview.route.distanceMeters)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">ETA (truck)</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums">
                {formatMinutes(preview.route.durationMinutes)}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            {preview.at !== null && (
              <>
                Leaving when previewed, it would arrive about{" "}
                {formatDateTime(
                  new Date(preview.at + preview.route.durationMinutes * 60_000),
                )}
                .{" "}
              </>
            )}
            Once a phone starts the trip, Radar&apos;s live ETA takes over.
          </p>
          {stale && (
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
              The points or radii changed since this preview — preview again to
              update it.
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function EndCard({
  title,
  color,
  value,
  onChange,
  disabled,
}: {
  title: string;
  color: string;
  value: EndDraft;
  onChange: (value: EndDraft) => void;
  disabled: boolean;
}) {
  const id = useId();
  const name = title.toLowerCase();

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPinIcon className="size-4" style={{ color }} />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs
          value={value.mode}
          onValueChange={(mode) => onChange({ ...value, mode: mode as Mode })}
        >
          <TabsList className="w-full">
            <TabsTrigger value="address" disabled={disabled}>
              Address
            </TabsTrigger>
            <TabsTrigger value="coordinates" disabled={disabled}>
              Latitude / longitude
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {value.mode === "address" ? (
          <AddressSearch
            id={`${id}-address`}
            label={`${title} address`}
            value={value}
            onChange={onChange}
            disabled={disabled}
          />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-lat`}>Latitude</Label>
              <Input
                id={`${id}-lat`}
                inputMode="decimal"
                placeholder="21.1702"
                value={value.latitude}
                onChange={(event) =>
                  onChange({ ...value, latitude: event.target.value })
                }
                disabled={disabled}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-lng`}>Longitude</Label>
              <Input
                id={`${id}-lng`}
                inputMode="decimal"
                placeholder="72.8311"
                value={value.longitude}
                onChange={(event) =>
                  onChange({ ...value, longitude: event.target.value })
                }
                disabled={disabled}
              />
            </div>
            <p className="col-span-2 text-xs text-muted-foreground">
              For a place the address search does not find. Decimal degrees.
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor={`${id}-radius`}>Geofence radius (meters)</Label>
          <Input
            id={`${id}-radius`}
            type="number"
            inputMode="numeric"
            min={MIN_GEOFENCE_RADIUS_METERS}
            max={MAX_GEOFENCE_RADIUS_METERS}
            step={10}
            value={value.radius}
            onChange={(event) =>
              onChange({ ...value, radius: event.target.value })
            }
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            {MIN_GEOFENCE_RADIUS_METERS}–
            {MAX_GEOFENCE_RADIUS_METERS.toLocaleString("en-US")} m. Radar
            reports the phone entering and exiting this circle around the {name}
            .
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** One Google suggestion. It has no coordinates until it is picked. */
type Suggestion = {
  prediction: google.maps.places.PlacePrediction;
  title: string;
  detail: string | null;
};

/**
 * A search box with Google Places suggestions underneath, as in a maps app.
 *
 * Picking one asks Google for that place's address and coordinates. Typing
 * again un-picks it, so the saved point is always the one whose address is
 * shown.
 *
 * All the typing for one pick shares a session token, so Google bills it as
 * one autocomplete session.
 */
function AddressSearch({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: EndDraft;
  onChange: (value: EndDraft) => void;
  disabled: boolean;
}) {
  // Google's Places library; null until the Google Maps script has loaded it.
  const places = useMapsLibrary("places");
  const sessionToken =
    useRef<google.maps.places.AutocompleteSessionToken | null>(null);

  // The results remember their query, so "no matches" is only said of a search that ran.
  const [results, setResults] = useState<{
    query: string;
    suggestions: Suggestion[];
  }>({
    query: "",
    suggestions: [],
  });
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const listId = `${id}-suggestions`;

  const query = value.query.trim();
  const picked = value.address !== null;
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!places || picked || query.length < MIN_QUERY_LENGTH) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        sessionToken.current ??= new places.AutocompleteSessionToken();
        const response =
          await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
            input: query,
            sessionToken: sessionToken.current,
          });
        if (cancelled) return;

        const suggestions: Suggestion[] = [];
        for (const item of response.suggestions) {
          const prediction = item.placePrediction;
          if (!prediction) continue;
          suggestions.push({
            prediction,
            title: prediction.mainText?.text ?? prediction.text.text,
            detail: prediction.secondaryText?.text ?? null,
          });
        }

        setResults({ query, suggestions });
        setHighlighted(0);
        setSearchError(null);
      } catch (cause) {
        if (cancelled) return;
        setResults({ query, suggestions: [] });
        setSearchError(
          cause instanceof Error ? cause.message : "Search failed.",
        );
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [places, query, picked]);

  /** Asks Google for the picked place's full address and coordinates. */
  async function pick(suggestion: Suggestion) {
    setOpen(false);
    setPicking(true);
    setSearchError(null);

    try {
      const place = suggestion.prediction.toPlace();
      await place.fetchFields({ fields: ["formattedAddress", "location"] });
      // This call ends the billing session; the next search starts a new one.
      sessionToken.current = null;

      if (!place.location)
        throw new Error("Google returned no location for this place.");

      const address = place.formattedAddress ?? suggestion.prediction.text.text;
      onChange({
        ...value,
        address,
        query: address,
        latitude: String(place.location.lat()),
        longitude: String(place.location.lng()),
      });
    } catch (cause) {
      setSearchError(
        cause instanceof Error ? cause.message : "Could not load this place.",
      );
    } finally {
      setPicking(false);
    }
  }

  const showList = open && !picked && query.length >= MIN_QUERY_LENGTH;
  // Until the search for this exact query has answered, the previous results
  // stay up (as in a maps app) and the box shows a spinner.
  const searching = (showList && results.query !== query) || picking;
  const suggestions = showList ? results.suggestions : [];

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          placeholder="Start typing an address or place"
          value={value.query}
          onChange={(event) => {
            // Typing again un-picks the address; the point goes with it.
            onChange({ ...value, query: event.target.value, address: null });
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Let a click on a suggestion land before the list closes.
            blurTimer.current = setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={(event) => {
            if (!showList || suggestions.length === 0) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlighted((index) => (index + 1) % suggestions.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlighted(
                (index) =>
                  (index - 1 + suggestions.length) % suggestions.length,
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              void pick(suggestions[highlighted]);
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          disabled={disabled}
          className="pr-8"
        />
        {searching && (
          <LoaderCircleIcon className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}

        {showList && (
          <ul
            id={listId}
            role="listbox"
            className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
            onMouseDown={() => {
              if (blurTimer.current) clearTimeout(blurTimer.current);
            }}
          >
            {suggestions.length === 0 ? (
              <li className="px-2 py-2 text-sm text-muted-foreground">
                {searching
                  ? "Searching…"
                  : searchError
                    ? `Search failed: ${searchError}`
                    : "No matches. Try another spelling, or switch to latitude / longitude."}
              </li>
            ) : (
              suggestions.map((suggestion, index) => (
                <li
                  key={suggestion.prediction.placeId}
                  role="option"
                  aria-selected={index === highlighted}
                  className={`flex cursor-pointer gap-2 rounded-md px-2 py-1.5 text-sm ${index === highlighted ? "bg-accent text-accent-foreground" : ""}`}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => void pick(suggestion)}
                >
                  <MapPinIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {suggestion.title}
                    </span>
                    {suggestion.detail && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {suggestion.detail}
                      </span>
                    )}
                  </span>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {picked ? (
          <span className="font-mono">
            {Number(value.latitude).toFixed(6)},{" "}
            {Number(value.longitude).toFixed(6)}
          </span>
        ) : searchError && !showList ? (
          <span className="text-destructive">{searchError}</span>
        ) : (
          "Pick one of the suggestions."
        )}
      </p>
    </div>
  );
}
