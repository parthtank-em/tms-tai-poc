"use client";

import {
  ExternalLinkIcon,
  PlayIcon,
  RotateCcwIcon,
  SendIcon,
  SquareIcon,
  WifiIcon,
  WifiOffIcon,
} from "lucide-react";
import Link from "next/link";
import type RadarType from "radar-sdk-js";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTimeSeconds } from "@/lib/format";
import { TRACKING_TAG_TARGET } from "@/lib/tracking/radar";

/**
 * A browser stand-in for the mobile app (plan §14, step 10).
 *
 * "Offline" is simulated: the network is still there, the simulator just stops
 * sending and queues instead — which is what the device's local queue does.
 * A live send that genuinely fails is queued the same way, so nothing is lost
 * if the dev server restarts mid-run.
 *
 * Geofencing is **real Radar**: the server creates the two fences in Radar at
 * Start, and each step sends the position to Radar with the web SDK's
 * `trackOnce`, as the phone's SDK would. Radar decides inside or outside and
 * reports crossings to the server by webhook. Unlike the phone SDK, the web SDK
 * cannot replay offline positions, so Radar sees nothing from an offline
 * stretch — expect a crossing made offline to be missed, not delayed.
 *
 * Distance and ETA come from the "phone": straight-line distance to the
 * destination and the walk's average speed stand in for the route a real app
 * would get from Google.
 */

type Point = { latitude: number; longitude: number };

type QueuedLocation = Point & {
  id: string;
  capturedAt: string;
  remainingDistanceMeters: number;
  eta: string;
};

type Target = "START" | "DESTINATION";

type Fence = Point & { radiusMeters: number };

type LogEntry = { at: Date; text: string; tone: "info" | "ok" | "error" };

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_RADAR_PUBLISHABLE_KEY;

/** Radar allows one track per second per device; leave headroom. */
const MIN_INTERVAL_SECONDS = 2;

/** Plan §5.2 says ~2 minutes on a device; a demo wants to see movement sooner. */
const DEFAULT_INTERVAL_SECONDS = 5;

/** A simulated fix this good, so Radar does not discard it as too inaccurate. */
const SIMULATED_ACCURACY_METERS = 10;

/** Surat, as in the plan's examples. */
const DEFAULT_START = { latitude: 21.1702, longitude: 72.8311 };

/** About 2 km north-east — a couple of minutes of walk at the default interval. */
const DEFAULT_DESTINATION = { latitude: 21.1832, longitude: 72.8441 };

const METERS_PER_DEGREE = 111_320;

/** A few steps of the walk, so a run shows the exit from the start fairly soon. */
const DEFAULT_START_RADIUS_METERS = 300;
const DEFAULT_DESTINATION_RADIUS_METERS = 300;

/** Each step moves 80–200 m; the midpoint drives the simulated ETA. */
const MIN_STEP_METERS = 80;
const MAX_STEP_METERS = 200;
const AVERAGE_STEP_METERS = (MIN_STEP_METERS + MAX_STEP_METERS) / 2;

const TARGET_LABEL: Record<Target, string> = { START: "start", DESTINATION: "destination" };

const NO_SIDES: Record<Target, boolean | null> = { START: null, DESTINATION: null };

const EARTH_RADIUS_METERS = 6_371_000;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Haversine — drives the walk and the simulated distance, not the geofencing. */
function distanceMeters(a: Point, b: Point): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

/** Heading from `a` to `b`, in radians clockwise from north — the walk's convention. */
function bearing(a: Point, b: Point): number {
  const north = b.latitude - a.latitude;
  const east = (b.longitude - a.longitude) * Math.cos(toRadians(a.latitude));
  return Math.atan2(east, north);
}

/**
 * A walk that wanders but drifts toward the destination, so the route looks
 * like a vehicle on roads and eventually arrives. Within one step it parks on
 * the destination, so it does not circle the fence and flap ENTER/EXIT.
 */
function nextPosition(from: Point, destination: Point): Point {
  const remaining = distanceMeters(from, destination);
  if (remaining <= MAX_STEP_METERS) return destination;

  const heading = bearing(from, destination) + (Math.random() - 0.5) * (Math.PI / 2);
  const meters = MIN_STEP_METERS + Math.random() * (MAX_STEP_METERS - MIN_STEP_METERS);
  const latitude = from.latitude + (meters * Math.cos(heading)) / METERS_PER_DEGREE;
  const longitude =
    from.longitude +
    (meters * Math.sin(heading)) / (METERS_PER_DEGREE * Math.cos(toRadians(from.latitude)));

  const round = (value: number) => Math.round(value * 1e7) / 1e7;
  return { latitude: round(latitude), longitude: round(longitude) };
}

/** What the phone would report: distance left, and when it gets there at the walk's pace. */
function progress(from: Point, destination: Point, intervalSeconds: number, now: Date) {
  const remainingDistanceMeters = Math.round(distanceMeters(from, destination));
  const metersPerSecond = AVERAGE_STEP_METERS / Math.max(1, intervalSeconds);
  const eta = new Date(now.getTime() + (remainingDistanceMeters / metersPerSecond) * 1000);
  return { remainingDistanceMeters, eta: eta.toISOString() };
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
  const [deviceId, setDeviceId] = useState("simulator-device-1");
  const [intervalSeconds, setIntervalSeconds] = useState(DEFAULT_INTERVAL_SECONDS);
  const [startLatitude, setStartLatitude] = useState(DEFAULT_START.latitude);
  const [startLongitude, setStartLongitude] = useState(DEFAULT_START.longitude);
  const [startRadius, setStartRadius] = useState(DEFAULT_START_RADIUS_METERS);
  const [destinationLatitude, setDestinationLatitude] = useState(DEFAULT_DESTINATION.latitude);
  const [destinationLongitude, setDestinationLongitude] = useState(DEFAULT_DESTINATION.longitude);
  const [destinationRadius, setDestinationRadius] = useState(DEFAULT_DESTINATION_RADIUS_METERS);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<QueuedLocation[]>([]);
  const [sentCount, setSentCount] = useState(0);
  const [lastBatch, setLastBatch] = useState<QueuedLocation[]>([]);
  const [position, setPosition] = useState<QueuedLocation | null>(null);
  const [crossings, setCrossings] = useState(0);
  const [inside, setInside] = useState<Record<Target, boolean | null>>(NO_SIDES);
  const [log, setLog] = useState<LogEntry[]>([]);

  // The tick runs from a timer, so it reads the latest values through refs
  // rather than whatever the render that scheduled it happened to capture.
  // Start() replaces this with the chosen start point.
  const radar = useRef<typeof RadarType | null>(null);
  const walk = useRef<Point>(DEFAULT_START);
  const onlineRef = useRef(online);
  const sessionRef = useRef(sessionId);
  const intervalRef = useRef(intervalSeconds);
  // The fences the current session was started with.
  const fencesRef = useRef<Record<Target, Fence> | null>(null);

  useEffect(() => {
    onlineRef.current = online;
    sessionRef.current = sessionId;
    intervalRef.current = intervalSeconds;
  }, [online, sessionId, intervalSeconds]);

  const addLog = useCallback((text: string, tone: LogEntry["tone"] = "info") => {
    setLog((entries) => [{ at: new Date(), text, tone }, ...entries].slice(0, 100));
  }, []);

  const enqueue = useCallback((location: QueuedLocation) => {
    setQueue((current) => [...current, location]);
  }, []);

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

  /**
   * Sends one position to Radar, as the phone's SDK would, and shows what
   * Radar decided: the crossings it fired and which of this session's fences
   * the device is now in. The server hears about the crossings by webhook.
   */
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

        const session = sessionRef.current;
        const ours = (geofence?: { tag?: string; externalId?: string }) =>
          geofence?.tag && geofence.externalId === session ? TRACKING_TAG_TARGET[geofence.tag] : undefined;

        for (const event of events ?? []) {
          const target = ours(event.geofence);
          if (!target) continue;
          if (event.type !== "user.entered_geofence" && event.type !== "user.exited_geofence") continue;

          setCrossings((count) => count + 1);
          addLog(
            `Radar: ${event.type === "user.entered_geofence" ? "entered" : "left"} ${TARGET_LABEL[target]} geofence`,
            "ok",
          );
        }

        if (session) {
          const current = new Set((user?.geofences ?? []).map(ours));
          setInside({ START: current.has("START"), DESTINATION: current.has("DESTINATION") });
        }
      } catch (error) {
        addLog(`Radar track failed: ${(error as Error).message}`, "error");
      }
    },
    [addLog],
  );

  const tick = useCallback(async () => {
    const session = sessionRef.current;
    const fences = fencesRef.current;
    if (!session || !fences) return;

    const next = nextPosition(walk.current, fences.DESTINATION);
    walk.current = next;

    const now = new Date();
    const location: QueuedLocation = {
      id: crypto.randomUUID(),
      latitude: next.latitude,
      longitude: next.longitude,
      capturedAt: now.toISOString(),
      ...progress(next, fences.DESTINATION, intervalRef.current, now),
    };
    setPosition(location);

    if (!onlineRef.current) {
      enqueue(location);
      addLog(`Offline — queued ${location.latitude}, ${location.longitude} (Radar will not see it)`);
      return;
    }

    await trackWithRadar(next);

    try {
      const result = await post(`/api/tracking/sessions/${session}/locations`, location);
      if (!result.ok) throw new Error(String(result.json.error ?? `HTTP ${result.status}`));

      setSentCount((count) => count + 1);
      addLog(`Sent ${location.latitude}, ${location.longitude}`, "ok");
    } catch (error) {
      enqueue(location);
      addLog(`Send failed (${(error as Error).message}) — queued instead`, "error");
    }
  }, [addLog, enqueue, trackWithRadar]);

  useEffect(() => {
    if (!running) return;

    const timer = setInterval(tick, Math.max(MIN_INTERVAL_SECONDS, intervalSeconds) * 1000);
    return () => clearInterval(timer);
  }, [running, intervalSeconds, tick]);

  async function flush(batch: QueuedLocation[], label = "Uploaded"): Promise<boolean> {
    if (!sessionId || batch.length === 0) return true;

    const result = await post(`/api/tracking/sessions/${sessionId}/locations/bulk`, {
      locations: batch,
    });

    if (!result.ok) {
      addLog(`Bulk upload failed: ${String(result.json.error ?? `HTTP ${result.status}`)}`, "error");
      return false;
    }

    const ids = new Set(batch.map((location) => location.id));
    setQueue((current) => current.filter((location) => !ids.has(location.id)));
    setLastBatch(batch);
    setSentCount((count) => count + Number(result.json.inserted ?? 0));
    addLog(
      `${label} ${batch.length} queued point(s): inserted ${String(result.json.inserted)}, skipped ${String(result.json.skipped)}`,
      "ok",
    );
    return true;
  }

  async function start() {
    setBusy(true);
    try {
      const id = deviceId.trim();
      await loadRadar(id);

      // Radar creates a user on its first track, and the session's fences are
      // scoped to that user — so the device reports where it is first.
      addLog("Tracking the start position so Radar knows the user");
      sessionRef.current = null;
      await trackWithRadar({ latitude: startLatitude, longitude: startLongitude });

      const fences: Record<Target, Fence> = {
        START: { latitude: startLatitude, longitude: startLongitude, radiusMeters: startRadius },
        DESTINATION: {
          latitude: destinationLatitude,
          longitude: destinationLongitude,
          radiusMeters: destinationRadius,
        },
      };
      const planned = progress(fences.START, fences.DESTINATION, intervalSeconds, new Date());

      const result = await post("/api/tracking/sessions", {
        deviceId: id,
        start: fences.START,
        destination: fences.DESTINATION,
        distanceMeters: planned.remainingDistanceMeters,
        eta: planned.eta,
      });
      if (!result.ok) {
        addLog(`Start failed: ${String(result.json.error ?? `HTTP ${result.status}`)}`, "error");
        return;
      }

      walk.current = { latitude: startLatitude, longitude: startLongitude };
      fencesRef.current = fences;
      setInside(NO_SIDES);
      setCrossings(0);
      setSessionId(String(result.json.sessionId));
      sessionRef.current = String(result.json.sessionId);
      setQueue([]);
      setLastBatch([]);
      setSentCount(0);
      setPosition(null);
      setRunning(true);
      addLog(
        `Started session ${String(result.json.sessionId)} — ${planned.remainingDistanceMeters} m to go`,
        "ok",
      );

      // Report the starting fix straight away rather than one interval later.
      await tick();
    } catch (error) {
      addLog(`Start failed: ${(error as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!sessionId) return;

    setBusy(true);
    setRunning(false);
    try {
      // A real device would flush its queue as soon as it is back online; the
      // simulator does it here so Stop never strands queued points.
      if (queue.length > 0) {
        onlineRef.current = true;
        setOnline(true);
        if (!(await flush(queue))) return;
      }

      const result = await post(`/api/tracking/sessions/${sessionId}/stop`);
      addLog(
        result.ok
          ? `Stopped session — status ${String(result.json.status)}`
          : `Stop failed: ${String(result.json.error ?? `HTTP ${result.status}`)}`,
        result.ok ? "ok" : "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleOnline() {
    // The ref is set directly as well, so a tick already due cannot slip a live
    // send in before the next render catches up.
    if (online) {
      onlineRef.current = false;
      setOnline(false);
      addLog("Connection lost — new points will be queued on the device, Radar gets nothing");
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

  async function resendLastBatch() {
    setBusy(true);
    try {
      await flush(lastBatch, "Retried");
    } finally {
      setBusy(false);
    }
  }

  const active = running && sessionId !== null;

  if (!PUBLISHABLE_KEY) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Radar is not configured</CardTitle>
          <CardDescription>
            Geofencing runs on Radar. Set <code className="font-mono">NEXT_PUBLIC_RADAR_PUBLISHABLE_KEY</code>{" "}
            (and the other Radar variables in <code className="font-mono">.env.example</code>) and
            restart the dev server.
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
          <Field
            id="deviceId"
            label="Device id"
            hint="Becomes the Radar userId. Each distinct id is a tracked user in Radar's billing."
          >
            <Input
              id="deviceId"
              value={deviceId}
              onChange={(event) => setDeviceId(event.target.value)}
              disabled={active}
            />
          </Field>

          <Field
            id="interval"
            label="Send every (seconds)"
            hint={`A real device sends about every 120 s. Minimum ${MIN_INTERVAL_SECONDS} s — Radar allows one track per second per device.`}
          >
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

          <TripEnd
            id="start"
            title="Start"
            latitude={startLatitude}
            longitude={startLongitude}
            radius={startRadius}
            onLatitude={setStartLatitude}
            onLongitude={setStartLongitude}
            onRadius={setStartRadius}
            disabled={active}
          />

          <TripEnd
            id="destination"
            title="Destination"
            hint="The walk drifts toward it in 80–200 m steps and parks there on arrival."
            latitude={destinationLatitude}
            longitude={destinationLongitude}
            radius={destinationRadius}
            onLatitude={setDestinationLatitude}
            onLongitude={setDestinationLongitude}
            onRadius={setDestinationRadius}
            disabled={active}
          />

          <div className="flex flex-wrap gap-2 pt-2">
            {active ? (
              <Button onClick={stop} disabled={busy} variant="destructive">
                <SquareIcon />
                Stop
              </Button>
            ) : (
              <Button onClick={start} disabled={busy || !deviceId.trim()}>
                <PlayIcon />
                Start new session
              </Button>
            )}

            <Button onClick={toggleOnline} disabled={!active || busy} variant="outline">
              {online ? <WifiOffIcon /> : <WifiIcon />}
              {online ? "Go offline" : "Go online"}
            </Button>

            <Button onClick={tick} disabled={!active || busy} variant="outline">
              <SendIcon />
              Send now
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>State</CardTitle>
          <CardDescription>
            {sessionId ? (
              <Link
                href={`/tracking/${sessionId}`}
                target="_blank"
                className="inline-flex items-center gap-1 underline underline-offset-4"
              >
                Open session on the map
                <ExternalLinkIcon className="size-3.5" />
              </Link>
            ) : (
              "No session yet."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Stat label="Session">
              <span className="font-mono text-xs">{sessionId ? sessionId.slice(0, 8) : "—"}</span>
            </Stat>
            <Stat label="Tracking">{active ? "Running" : sessionId ? "Stopped" : "—"}</Stat>
            <Stat label="Connection">
              <span className={online ? "" : "font-medium text-amber-600"}>
                {online ? "Online" : "Offline"}
              </span>
            </Stat>
            <Stat label="Stored on server">{sentCount}</Stat>
            <Stat label="Queued on device">{queue.length}</Stat>
            <Stat label="Start geofence">
              <Side inside={inside.START} />
            </Stat>
            <Stat label="Destination geofence">
              <Side inside={inside.DESTINATION} />
            </Stat>
            <Stat label="Remaining distance">
              {position ? `${position.remainingDistanceMeters.toLocaleString("en-US")} m` : "—"}
            </Stat>
            <Stat label="ETA">
              {position ? formatDateTimeSeconds(new Date(position.eta)) : "—"}
            </Stat>
            <Stat label="Radar crossings">{crossings}</Stat>
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
            Geofence state and crossings here come straight from Radar&apos;s track response. The
            session page shows what arrived by webhook — if this updates and the page does not, the
            webhook is not reaching the app.
          </p>

          <div className="mt-4 border-t pt-4">
            <p className="mb-2 text-sm text-muted-foreground">
              Idempotency check: resend the last bulk batch. Every point should come back skipped.
            </p>
            <Button
              onClick={resendLastBatch}
              disabled={busy || lastBatch.length === 0}
              variant="outline"
              size="sm"
            >
              <RotateCcwIcon />
              Resend last batch ({lastBatch.length})
            </Button>
          </div>
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

/** A trip end's point and geofence radius. */
function TripEnd({
  id,
  title,
  hint,
  latitude,
  longitude,
  radius,
  onLatitude,
  onLongitude,
  onRadius,
  disabled,
}: {
  id: string;
  title: string;
  hint?: string;
  latitude: number;
  longitude: number;
  radius: number;
  onLatitude: (value: number) => void;
  onLongitude: (value: number) => void;
  onRadius: (value: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <p className="text-sm font-medium">{title}</p>
      <div className="grid grid-cols-3 gap-3">
        <Field id={`${id}-lat`} label="Latitude">
          <Input
            id={`${id}-lat`}
            type="number"
            step="any"
            value={latitude}
            onChange={(event) => onLatitude(Number(event.target.value))}
            disabled={disabled}
          />
        </Field>
        <Field id={`${id}-lng`} label="Longitude">
          <Input
            id={`${id}-lng`}
            type="number"
            step="any"
            value={longitude}
            onChange={(event) => onLongitude(Number(event.target.value))}
            disabled={disabled}
          />
        </Field>
        <Field id={`${id}-radius`} label="Geofence (m)">
          <Input
            id={`${id}-radius`}
            type="number"
            min={50}
            value={radius}
            onChange={(event) => onRadius(Math.round(Number(event.target.value)) || 50)}
            disabled={disabled}
          />
        </Field>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Side({ inside }: { inside: boolean | null }) {
  if (inside === null) return "—";

  return (
    <span className={inside ? "text-emerald-600" : "font-medium text-amber-600"}>
      {inside ? "Inside" : "Outside"}
    </span>
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
