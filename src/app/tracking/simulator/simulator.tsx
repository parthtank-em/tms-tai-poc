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
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTimeSeconds } from "@/lib/format";

/**
 * A browser stand-in for the mobile app (plan §14, step 10).
 *
 * "Offline" is simulated: the network is still there, the simulator just stops
 * sending and queues instead — which is what the device's local queue does.
 * A live send that genuinely fails is queued the same way, so nothing is lost
 * if the dev server restarts mid-run.
 *
 * Geofencing works as it will on the phone: the server only stores the circle,
 * and the simulator itself decides inside or outside after every step and
 * reports each crossing as an ENTER or EXIT event.
 */

type QueuedLocation = { id: string; latitude: number; longitude: number; capturedAt: string };

/** `isOffline` is decided when the event is sent, not when it is detected. */
type QueuedGeofenceEvent = { id: string; type: "ENTER" | "EXIT"; capturedAt: string };

type Fence = { latitude: number; longitude: number; radiusMeters: number };

type LogEntry = { at: Date; text: string; tone: "info" | "ok" | "error" };

/** Plan §5.2 says ~2 minutes on a device; a demo wants to see movement sooner. */
const DEFAULT_INTERVAL_SECONDS = 5;

/** Surat, as in the plan's examples. */
const DEFAULT_START = { latitude: 21.1702, longitude: 72.8311 };

const METERS_PER_DEGREE = 111_320;

/** A few steps of the random walk, so a run shows an exit fairly soon. */
const DEFAULT_GEOFENCE_RADIUS_METERS = 500;

const EARTH_RADIUS_METERS = 6_371_000;

/** Haversine — what the phone's OS geofencing does for us on a real device. */
function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

/**
 * A random walk that mostly keeps its heading, so the route looks like a
 * vehicle on roads rather than a cloud of points.
 */
function nextPosition(
  from: { latitude: number; longitude: number },
  heading: number,
): { latitude: number; longitude: number; heading: number } {
  const turned = heading + (Math.random() - 0.5) * (Math.PI / 3);
  const meters = 80 + Math.random() * 120;
  const latitude = from.latitude + (meters * Math.cos(turned)) / METERS_PER_DEGREE;
  const longitude =
    from.longitude +
    (meters * Math.sin(turned)) / (METERS_PER_DEGREE * Math.cos((from.latitude * Math.PI) / 180));

  const round = (value: number) => Math.round(value * 1e7) / 1e7;
  return { latitude: round(latitude), longitude: round(longitude), heading: turned };
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
  const [geofenceEnabled, setGeofenceEnabled] = useState(true);
  const [geofenceRadius, setGeofenceRadius] = useState(DEFAULT_GEOFENCE_RADIUS_METERS);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<QueuedLocation[]>([]);
  const [sentCount, setSentCount] = useState(0);
  const [lastBatch, setLastBatch] = useState<QueuedLocation[]>([]);
  const [position, setPosition] = useState<QueuedLocation | null>(null);
  const [eventQueue, setEventQueue] = useState<QueuedGeofenceEvent[]>([]);
  const [eventsSent, setEventsSent] = useState(0);
  const [inside, setInside] = useState<boolean | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  // The tick runs from a timer, so it reads the latest values through refs
  // rather than whatever the render that scheduled it happened to capture.
  // Start() replaces this with the chosen start point and a random heading.
  const walk = useRef({ ...DEFAULT_START, heading: 0 });
  const onlineRef = useRef(online);
  const sessionRef = useRef(sessionId);
  // The fence the current session was started with, and which side of it the
  // device was on after the last step. Null when the session has no fence.
  const fenceRef = useRef<Fence | null>(null);
  const insideRef = useRef<boolean | null>(null);

  useEffect(() => {
    onlineRef.current = online;
    sessionRef.current = sessionId;
  }, [online, sessionId]);

  const addLog = useCallback((text: string, tone: LogEntry["tone"] = "info") => {
    setLog((entries) => [{ at: new Date(), text, tone }, ...entries].slice(0, 100));
  }, []);

  const enqueue = useCallback((location: QueuedLocation) => {
    setQueue((current) => [...current, location]);
  }, []);

  /** Sends one crossing live, or queues it when offline or the send fails. */
  const reportCrossing = useCallback(
    async (session: string, event: QueuedGeofenceEvent) => {
      const label = event.type === "ENTER" ? "Entered geofence" : "Left geofence";

      if (!onlineRef.current) {
        setEventQueue((current) => [...current, event]);
        addLog(`${label} — offline, event queued`);
        return;
      }

      try {
        const result = await post(`/api/tracking/sessions/${session}/geofence-events`, {
          events: [{ ...event, isOffline: false }],
        });
        if (!result.ok) throw new Error(String(result.json.error ?? `HTTP ${result.status}`));

        setEventsSent((count) => count + 1);
        addLog(`${label} — event sent`, "ok");
      } catch (error) {
        setEventQueue((current) => [...current, event]);
        addLog(`${label} — send failed (${(error as Error).message}), event queued`, "error");
      }
    },
    [addLog],
  );

  /**
   * Compares the new position against the fence and reports a change of side.
   * The first position only sets the starting side, except that starting
   * inside reports an ENTER — as Android's INITIAL_TRIGGER_ENTER would — so
   * the map has a status from the start.
   */
  const checkGeofence = useCallback(
    async (session: string, location: QueuedLocation) => {
      const fence = fenceRef.current;
      if (!fence) return;

      const nowInside = distanceMeters(location, fence) <= fence.radiusMeters;
      const previous = insideRef.current;
      insideRef.current = nowInside;
      setInside(nowInside);

      if (previous === nowInside || (previous === null && !nowInside)) return;

      await reportCrossing(session, {
        id: crypto.randomUUID(),
        type: nowInside ? "ENTER" : "EXIT",
        capturedAt: location.capturedAt,
      });
    },
    [reportCrossing],
  );

  const tick = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;

    const next = nextPosition(walk.current, walk.current.heading);
    walk.current = next;

    const location: QueuedLocation = {
      id: crypto.randomUUID(),
      latitude: next.latitude,
      longitude: next.longitude,
      capturedAt: new Date().toISOString(),
    };
    setPosition(location);

    if (!onlineRef.current) {
      enqueue(location);
      addLog(`Offline — queued ${location.latitude}, ${location.longitude}`);
    } else {
      try {
        const result = await post(`/api/tracking/sessions/${session}/locations`, location);
        if (!result.ok) throw new Error(String(result.json.error ?? `HTTP ${result.status}`));

        setSentCount((count) => count + 1);
        addLog(`Sent ${location.latitude}, ${location.longitude}`, "ok");
      } catch (error) {
        enqueue(location);
        addLog(`Send failed (${(error as Error).message}) — queued instead`, "error");
      }
    }

    await checkGeofence(session, location);
  }, [addLog, enqueue, checkGeofence]);

  useEffect(() => {
    if (!running) return;

    const timer = setInterval(tick, Math.max(1, intervalSeconds) * 1000);
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

  /** Everything queued goes up with `isOffline: true` — that is what it was. */
  async function flushEvents(batch: QueuedGeofenceEvent[]): Promise<boolean> {
    if (!sessionId || batch.length === 0) return true;

    const result = await post(`/api/tracking/sessions/${sessionId}/geofence-events`, {
      events: batch.map((event) => ({ ...event, isOffline: true })),
    });

    if (!result.ok) {
      addLog(`Geofence event upload failed: ${String(result.json.error ?? `HTTP ${result.status}`)}`, "error");
      return false;
    }

    const ids = new Set(batch.map((event) => event.id));
    setEventQueue((current) => current.filter((event) => !ids.has(event.id)));
    setEventsSent((count) => count + Number(result.json.inserted ?? 0));
    addLog(
      `Uploaded ${batch.length} queued geofence event(s): inserted ${String(result.json.inserted)}, skipped ${String(result.json.skipped)}`,
      "ok",
    );
    return true;
  }

  async function start() {
    setBusy(true);
    try {
      const fence: Fence | null = geofenceEnabled
        ? { latitude: startLatitude, longitude: startLongitude, radiusMeters: geofenceRadius }
        : null;

      const result = await post("/api/tracking/sessions", { deviceId, geofence: fence });
      if (!result.ok) {
        addLog(`Start failed: ${String(result.json.error ?? `HTTP ${result.status}`)}`, "error");
        return;
      }

      walk.current = {
        latitude: startLatitude,
        longitude: startLongitude,
        heading: Math.random() * 2 * Math.PI,
      };
      fenceRef.current = fence;
      insideRef.current = null;
      setInside(null);
      setEventQueue([]);
      setEventsSent(0);
      setSessionId(String(result.json.sessionId));
      sessionRef.current = String(result.json.sessionId);
      setQueue([]);
      setLastBatch([]);
      setSentCount(0);
      setPosition(null);
      setRunning(true);
      addLog(`Started session ${String(result.json.sessionId)}`, "ok");

      // Report the starting fix straight away rather than one interval later.
      await tick();
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
      if (queue.length > 0 || eventQueue.length > 0) {
        onlineRef.current = true;
        setOnline(true);
        if (!(await flush(queue))) return;
        if (!(await flushEvents(eventQueue))) return;
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
      addLog("Connection lost — new points will be queued on the device");
      return;
    }

    onlineRef.current = true;
    setOnline(true);
    addLog("Connection restored");
    setBusy(true);
    try {
      await flush(queue);
      await flushEvents(eventQueue);
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

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Device</CardTitle>
          <CardDescription>Settings apply to the next Start.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field id="deviceId" label="Device id">
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
            hint="A real device sends about every 120 s."
          >
            <Input
              id="interval"
              type="number"
              min={1}
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(Number(event.target.value) || 1)}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field id="lat" label="Start latitude">
              <Input
                id="lat"
                type="number"
                step="any"
                value={startLatitude}
                onChange={(event) => setStartLatitude(Number(event.target.value))}
                disabled={active}
              />
            </Field>
            <Field id="lng" label="Start longitude">
              <Input
                id="lng"
                type="number"
                step="any"
                value={startLongitude}
                onChange={(event) => setStartLongitude(Number(event.target.value))}
                disabled={active}
              />
            </Field>
          </div>

          <div className="grid gap-3 rounded-lg border p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={geofenceEnabled}
                onChange={(event) => setGeofenceEnabled(event.target.checked)}
                disabled={active}
                className="size-4 accent-primary"
              />
              Geofence around the start point
            </label>
            {geofenceEnabled && (
              <Field
                id="radius"
                label="Geofence radius (meters)"
                hint="Each step moves 80–200 m, so the walk leaves a small fence within a few steps."
              >
                <Input
                  id="radius"
                  type="number"
                  min={50}
                  value={geofenceRadius}
                  onChange={(event) => setGeofenceRadius(Math.round(Number(event.target.value)) || 50)}
                  disabled={active}
                />
              </Field>
            )}
          </div>

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
            <Stat label="Geofence">
              {inside === null ? (
                "—"
              ) : (
                <span className={inside ? "text-emerald-600" : "font-medium text-amber-600"}>
                  {inside ? "Inside" : "Outside"}
                </span>
              )}
            </Stat>
            <Stat label="Geofence events">
              {eventsSent} sent · {eventQueue.length} queued
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

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
