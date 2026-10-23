"use client";

import { ExternalLinkIcon, PlayIcon, RefreshCwIcon, SendIcon, SquareIcon, WifiIcon, WifiOffIcon } from "lucide-react";
import Link from "next/link";
import type RadarType from "radar-sdk-js";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTimeSeconds } from "@/lib/format";
import { endLabel, eventLabel, formatDistance, formatMinutes } from "@/lib/tracking/display";
import type { GeofenceTarget, SessionView } from "@/lib/tracking/types";

/**
 * A browser stand-in for the mobile app, driving **real Radar** — a copy of the
 * Radar POC's simulator (src/app/radar-tracking/simulator) for /tracking.
 *
 * Like the app, it lists the trips planned on the portal and starts one; the
 * server then creates that trip's fences and Radar trip for this device.
 *
 * Each step sends the simulated position to Radar with the web SDK's
 * `trackOnce({ latitude, longitude })`, exactly as the phone's SDK would track
 * it, so Radar evaluates the fences and the trip and fires real webhooks. The
 * same position is forwarded to our locations endpoint for the route line,
 * which is what the app does from its location listener.
 *
 * Unlike the phone SDK, the web SDK cannot replay offline locations. "Offline"
 * here queues route points for a bulk upload, but Radar never sees the
 * positions from that stretch — expect a gap in Radar's events, not in the line.
 */

type Point = { latitude: number; longitude: number };

type QueuedLocation = Point & { id: string; accuracy: number; capturedAt: string };

type LogEntry = { at: Date; text: string; tone: "info" | "ok" | "error" };

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_RADAR_PUBLISHABLE_KEY;

/** Radar allows one track per second per device; leave headroom. */
const MIN_INTERVAL_SECONDS = 2;
const DEFAULT_INTERVAL_SECONDS = 5;

/** A simulated fix this good, so Radar does not discard it as too inaccurate. */
const SIMULATED_ACCURACY_METERS = 10;

const METERS_PER_DEGREE = 111_320;
const MIN_STEP_METERS = 80;
const MAX_STEP_METERS = 200;
const EARTH_RADIUS_METERS = 6_371_000;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

function distanceMeters(a: Point, b: Point): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

/**
 * A walk that wanders but drifts toward the destination and parks on it once
 * within a step, so it arrives rather than circling the fence.
 */
function nextPosition(from: Point, destination: Point): Point {
  if (distanceMeters(from, destination) <= MAX_STEP_METERS) return destination;

  const north = destination.latitude - from.latitude;
  const east = (destination.longitude - from.longitude) * Math.cos(toRadians(from.latitude));
  const heading = Math.atan2(east, north) + (Math.random() - 0.5) * (Math.PI / 2);
  const meters = MIN_STEP_METERS + Math.random() * (MAX_STEP_METERS - MIN_STEP_METERS);

  const round = (value: number) => Math.round(value * 1e7) / 1e7;
  return {
    latitude: round(from.latitude + (meters * Math.cos(heading)) / METERS_PER_DEGREE),
    longitude: round(
      from.longitude +
        (meters * Math.sin(heading)) / (METERS_PER_DEGREE * Math.cos(toRadians(from.latitude))),
    ),
  };
}

const TAG_TARGET: Record<string, GeofenceTarget> = {
  "tms-track-start": "START",
  "tms-track-dest": "DESTINATION",
};

async function fetchPlannedTrips(): Promise<SessionView[]> {
  const response = await fetch("/api/tracking/sessions?status=PLANNED", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as SessionView[];
}

async function post(
  url: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, json };
}

export function Simulator() {
  const [deviceId, setDeviceId] = useState("radar-simulator-1");
  const [intervalSeconds, setIntervalSeconds] = useState(DEFAULT_INTERVAL_SECONDS);
  const [plannedTrips, setPlannedTrips] = useState<SessionView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [tripId, setTripId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<QueuedLocation[]>([]);
  const [position, setPosition] = useState<Point | null>(null);
  const [radarTrip, setRadarTrip] = useState<{ status: string; minutes?: number; meters?: number } | null>(
    null,
  );
  const [log, setLog] = useState<LogEntry[]>([]);

  // The tick runs from a timer, so it reads the latest values through refs.
  const radar = useRef<typeof RadarType | null>(null);
  const walk = useRef<Point | null>(null);
  const destinationRef = useRef<Point | null>(null);
  const onlineRef = useRef(online);
  const tripRef = useRef(tripId);

  useEffect(() => {
    onlineRef.current = online;
    tripRef.current = tripId;
  }, [online, tripId]);

  const addLog = useCallback((text: string, tone: LogEntry["tone"] = "info") => {
    setLog((entries) => [{ at: new Date(), text, tone }, ...entries].slice(0, 150));
  }, []);

  /** The trips a phone could start, as the app's trip list shows them. */
  const loadPlannedTrips = useCallback(
    () =>
      fetchPlannedTrips().then(
        (trips) => {
          setPlannedTrips(trips);
          setSelectedId((current) =>
            current && trips.some((trip) => trip.id === current) ? current : (trips[0]?.id ?? null),
          );
        },
        (error: Error) => {
          setPlannedTrips([]);
          addLog(`Could not load planned trips: ${error.message}`, "error");
        },
      ),
    [addLog],
  );

  // Fetched once on mount, like the app's list screen.
  useEffect(() => {
    void loadPlannedTrips();
  }, [loadPlannedTrips]);

  /** Loaded on first use: the SDK touches browser globals and must not run on the server. */
  const loadRadar = useCallback(async (userId: string) => {
    if (!radar.current) {
      const { default: Radar } = await import("radar-sdk-js");
      Radar.initialize(PUBLISHABLE_KEY!);
      radar.current = Radar;
    }
    radar.current.setUserId(userId);
    return radar.current;
  }, []);

  /** Sends one position to Radar and logs what Radar decided about it. */
  const trackWithRadar = useCallback(
    async (point: Point) => {
      const Radar = radar.current;
      if (!Radar) return;

      try {
        const { events, user } = await Radar.trackOnce({
          latitude: point.latitude,
          longitude: point.longitude,
          accuracy: SIMULATED_ACCURACY_METERS,
        });

        for (const event of events ?? []) {
          const target = event.geofence?.tag ? (TAG_TARGET[event.geofence.tag] ?? null) : null;
          addLog(`Radar: ${eventLabel({ type: event.type, target })}`, "ok");
        }

        const trip = user?.trip;
        if (trip) {
          setRadarTrip({ status: trip.status, minutes: trip.eta?.duration, meters: trip.eta?.distance });
        }
      } catch (error) {
        addLog(`Radar track failed: ${(error as Error).message}`, "error");
      }
    },
    [addLog],
  );

  const tick = useCallback(async () => {
    const trip = tripRef.current;
    if (!trip || !walk.current || !destinationRef.current) return;

    const next = nextPosition(walk.current, destinationRef.current);
    walk.current = next;
    setPosition(next);

    const location: QueuedLocation = {
      id: crypto.randomUUID(),
      ...next,
      accuracy: SIMULATED_ACCURACY_METERS,
      capturedAt: new Date().toISOString(),
    };

    if (!onlineRef.current) {
      setQueue((current) => [...current, location]);
      addLog(`Offline — queued ${next.latitude}, ${next.longitude} (Radar will not see it)`);
      return;
    }

    await trackWithRadar(next);

    try {
      const result = await post(`/api/tracking/sessions/${trip}/locations`, location);
      if (!result.ok) throw new Error(String(result.json.error ?? `HTTP ${result.status}`));
      addLog(`Sent ${next.latitude}, ${next.longitude}`);
    } catch (error) {
      setQueue((current) => [...current, location]);
      addLog(`Route point send failed (${(error as Error).message}) — queued`, "error");
    }
  }, [addLog, trackWithRadar]);

  useEffect(() => {
    if (!running) return;

    const timer = setInterval(tick, Math.max(MIN_INTERVAL_SECONDS, intervalSeconds) * 1000);
    return () => clearInterval(timer);
  }, [running, intervalSeconds, tick]);

  async function flush(batch: QueuedLocation[]): Promise<boolean> {
    if (!tripId || batch.length === 0) return true;

    const result = await post(`/api/tracking/sessions/${tripId}/locations/bulk`, {
      locations: batch,
    });

    if (!result.ok) {
      addLog(`Bulk upload failed: ${String(result.json.error ?? `HTTP ${result.status}`)}`, "error");
      return false;
    }

    const ids = new Set(batch.map((location) => location.id));
    setQueue((current) => current.filter((location) => !ids.has(location.id)));
    addLog(
      `Uploaded ${batch.length} queued point(s): inserted ${String(result.json.inserted)}, skipped ${String(result.json.skipped)}`,
      "ok",
    );
    return true;
  }

  async function startTrip() {
    const selected = plannedTrips?.find((trip) => trip.id === selectedId);
    if (!selected) return;

    setBusy(true);
    try {
      const id = deviceId.trim();
      await loadRadar(id);

      // Radar creates a user on its first track, and the fences and trip the
      // server creates below name that user — so the device reports where it
      // is before pressing Start.
      addLog("Tracking the start position so Radar knows the user");
      await trackWithRadar(selected.start);

      const result = await post(`/api/tracking/sessions/${selected.id}/start`, { deviceId: id });
      if (!result.ok) {
        addLog(`Start failed: ${String(result.json.error ?? `HTTP ${result.status}`)}`, "error");
        if (result.status === 409 || result.status === 404) await loadPlannedTrips();
        return;
      }

      const newTripId = String(result.json.sessionId);
      walk.current = { latitude: selected.start.latitude, longitude: selected.start.longitude };
      destinationRef.current = selected.destination;
      tripRef.current = newTripId;
      setTripId(newTripId);
      setQueue([]);
      setPosition(null);
      setRadarTrip(result.json.tripStatus ? { status: String(result.json.tripStatus).toLowerCase() } : null);
      setRunning(true);
      addLog(`Started trip ${newTripId} — Radar trip status ${String(result.json.tripStatus)}`, "ok");

      await tick();
    } catch (error) {
      addLog(`Start failed: ${(error as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function stopTrip() {
    if (!tripId) return;

    setBusy(true);
    setRunning(false);
    try {
      if (queue.length > 0) {
        onlineRef.current = true;
        setOnline(true);
        if (!(await flush(queue))) return;
      }

      const result = await post(`/api/tracking/sessions/${tripId}/stop`);
      if (!result.ok) {
        addLog(`Stop failed: ${String(result.json.error ?? `HTTP ${result.status}`)}`, "error");
        return;
      }

      addLog(`Stopped trip — Radar trip status ${String(result.json.tripStatus)}`, "ok");
      if (result.json.radarSyncError) {
        addLog(`Radar sync error: ${String(result.json.radarSyncError)}`, "error");
      }
      await loadPlannedTrips();
    } finally {
      setBusy(false);
    }
  }

  async function toggleOnline() {
    if (online) {
      onlineRef.current = false;
      setOnline(false);
      addLog("Connection lost — route points will be queued, Radar gets nothing");
      return;
    }

    onlineRef.current = true;
    setOnline(true);
    addLog("Connection restored");
    setBusy(true);
    try {
      await flush(queue);
    } finally {
      setBusy(false);
    }
  }

  const active = running && tripId !== null;
  const selected = plannedTrips?.find((trip) => trip.id === selectedId) ?? null;

  if (!PUBLISHABLE_KEY) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Radar is not configured</CardTitle>
          <CardDescription>
            Set <code className="font-mono">NEXT_PUBLIC_RADAR_PUBLISHABLE_KEY</code> (and the other
            Radar variables in <code className="font-mono">.env.example</code>) and restart the dev
            server.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Device</CardTitle>
          <CardDescription>Settings apply to the next Start.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field id="deviceId" label="Device id" hint="Becomes the Radar userId. Each distinct id is a tracked user in Radar's billing.">
            <Input
              id="deviceId"
              value={deviceId}
              onChange={(event) => setDeviceId(event.target.value)}
              disabled={active}
            />
          </Field>

          <Field id="interval" label="Track every (seconds)" hint={`Minimum ${MIN_INTERVAL_SECONDS} s — Radar allows one track per second per device.`}>
            <Input
              id="interval"
              type="number"
              min={MIN_INTERVAL_SECONDS}
              value={intervalSeconds}
              onChange={(event) =>
                setIntervalSeconds(Math.max(MIN_INTERVAL_SECONDS, Number(event.target.value) || 0))
              }
            />
          </Field>

          <Field
            id="trip"
            label="Planned trip"
            hint="The walk starts at the source and drifts toward the destination in 80–200 m steps, parking there on arrival."
          >
            <div className="flex gap-2">
              <Select
                value={selectedId}
                onValueChange={(value) => setSelectedId(value as string)}
                disabled={active || !plannedTrips?.length}
              >
                <SelectTrigger id="trip" className="h-8 w-full min-w-0">
                  <SelectValue>
                    {() =>
                      selected
                        ? `${selected.id.slice(0, 8)} · ${endLabel(selected.start)} → ${endLabel(selected.destination)}`
                        : plannedTrips === null
                          ? "Loading…"
                          : "No planned trips"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {(plannedTrips ?? []).map((trip) => (
                    <SelectItem key={trip.id} value={trip.id}>
                      {trip.id.slice(0, 8)} · {endLabel(trip.start)} → {endLabel(trip.destination)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => void loadPlannedTrips()}
                disabled={active}
                aria-label="Reload planned trips"
              >
                <RefreshCwIcon />
              </Button>
            </div>
          </Field>

          {plannedTrips?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No planned trips.{" "}
              <Link href="/tracking/new" className="underline underline-offset-4">
                Add one
              </Link>{" "}
              on the portal first.
            </p>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            {active ? (
              <Button onClick={stopTrip} disabled={busy} variant="destructive">
                <SquareIcon />
                Stop
              </Button>
            ) : (
              <Button onClick={startTrip} disabled={busy || !deviceId.trim() || !selected}>
                <PlayIcon />
                Start trip
              </Button>
            )}

            <Button onClick={toggleOnline} disabled={!active || busy} variant="outline">
              {online ? <WifiOffIcon /> : <WifiIcon />}
              {online ? "Go offline" : "Go online"}
            </Button>

            <Button onClick={tick} disabled={!active || busy} variant="outline">
              <SendIcon />
              Step now
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>State</CardTitle>
          <CardDescription>
            {tripId ? (
              <Link
                href={`/tracking/${tripId}`}
                target="_blank"
                className="inline-flex items-center gap-1 underline underline-offset-4"
              >
                Open trip on the map
                <ExternalLinkIcon className="size-3.5" />
              </Link>
            ) : (
              "No trip yet."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Stat label="Trip">
              <span className="font-mono text-xs">{tripId ? tripId.slice(0, 8) : "—"}</span>
            </Stat>
            <Stat label="Tracking">{active ? "Running" : tripId ? "Stopped" : "—"}</Stat>
            <Stat label="Connection">
              <span className={online ? "" : "font-medium text-amber-600"}>
                {online ? "Online" : "Offline"}
              </span>
            </Stat>
            <Stat label="Queued route points">{queue.length}</Stat>
            <Stat label="Radar trip status">{radarTrip?.status ?? "—"}</Stat>
            <Stat label="Radar ETA">
              {radarTrip?.minutes !== undefined
                ? `${formatMinutes(radarTrip.minutes)} · ${formatDistance(radarTrip.meters === undefined ? null : Math.round(radarTrip.meters))}`
                : "—"}
            </Stat>
            <Stat label="Current position">
              {position ? (
                <span className="font-mono text-xs">
                  {position.latitude.toFixed(5)}, {position.longitude.toFixed(5)}
                </span>
              ) : (
                "—"
              )}
            </Stat>
          </dl>
          <p className="mt-4 border-t pt-4 text-xs text-muted-foreground">
            Status and ETA here come straight from Radar&apos;s track response. The trip page shows
            what arrived by webhook — if this updates and the page does not, the webhook is not
            reaching the app.
          </p>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Log</CardTitle>
        </CardHeader>
        <CardContent>
          {log.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet — press Start.</p>
          ) : (
            <ol className="max-h-80 overflow-y-auto font-mono text-xs">
              {log.map((entry, index) => (
                <li
                  key={`${entry.at.getTime()}-${index}`}
                  className={
                    entry.tone === "error"
                      ? "text-destructive"
                      : entry.tone === "ok"
                        ? ""
                        : "text-muted-foreground"
                  }
                >
                  <span className="text-muted-foreground">{formatDateTimeSeconds(entry.at)}</span>{" "}
                  {entry.text}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
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
