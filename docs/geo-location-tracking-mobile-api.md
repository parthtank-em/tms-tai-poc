# Geo Location Tracking — Mobile API Reference

For developers building the mobile app. It covers the Radar SDK setup and the four endpoints a device calls: start a session (a trip with a start and a destination, each with a geofence), send a location, upload an offline batch, and stop.

This POC is a **hybrid**:

- **Geofencing is Radar.** The server creates the two fences in Radar, and the Radar SDK on the phone decides when the device enters or leaves them. Radar reports each crossing to the server by webhook, so **the app doesn't report geofence events**.
- **Distance and ETA are Google, on the phone.** The app gets them from the Google Routes API and sends them with each location. The server stores what the phone reports; it does no routing of its own.
- **The web map is Google Maps.**

Radar trips aren't used, so Radar never computes an ETA here. (The separate Radar POC, [radar-tracking-mobile-api.md](./radar-tracking-mobile-api.md), is the Radar-only alternative.)

Design background is in [geo-location-tracking-poc-implementation.md](./geo-location-tracking-poc-implementation.md).

---

## 1. Overview

A **session** is one tracking run. Every tap on **Start** creates a new session, and all locations until **Stop** belong to it.

```text
Start ──► POST /api/tracking/sessions                      → sessionId; the server creates both
  │        (start, destination, distanceMeters, eta)          fences in Radar for this deviceId
  │       Radar.startTracking(...)
  │
  ├─ each Radar SDK location:
  │    online:  POST /api/tracking/sessions/{sessionId}/locations       (one point, with the
  │    offline: keep points in a local queue                             Google distance + ETA)
  │    back online: POST /api/tracking/sessions/{sessionId}/locations/bulk  (the queue)
  │
  ├─ geofence crossed: nothing for the app to do — Radar tells the server by webhook
  │                    (offline crossings are replayed by the SDK when back online)
  │
Stop ──► Radar.stopTracking(); POST /api/tracking/sessions/{sessionId}/stop   (server deletes the fences)
```

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/tracking/sessions` | [Start a session](#31-start-a-session) |
| POST | `/api/tracking/sessions/{sessionId}/locations` | [Send one location](#32-send-one-location) |
| POST | `/api/tracking/sessions/{sessionId}/locations/bulk` | [Upload queued locations](#33-upload-queued-locations-bulk) |
| POST | `/api/tracking/sessions/{sessionId}/geofence-events` | [Legacy — don't call](#34-report-geofence-events-legacy) |
| POST | `/api/tracking/sessions/{sessionId}/stop` | [Stop the session](#35-stop-a-session) |

### 1.1 Who does what

| Concern | Who |
|---|---|
| Location tracking in the background, battery, offline replay to Radar | **Radar SDK** on the phone |
| Deciding when the device enters or leaves the start and destination | **Radar**, from the SDK's locations |
| Creating the two fences in Radar, and deleting them at Stop | **Our backend**, on `POST /sessions` and `POST /stop` |
| Distance and ETA | **The app**, from the Google Routes API |
| The route line on the web map | **The app** forwards each SDK location to our backend |

### 1.2 Radar SDK setup (once per app launch)

Use the Radar **test** publishable key (`prj_test_pk_…`) from the team.

```text
Radar.initialize(publishableKey)
Radar.setUserId(deviceId)          // the same deviceId you send to our API
request "Always" location permission (background location on Android)
Radar.trackOnce()                  // creates the Radar user before a session's fences name it
```

`deviceId` must be stable for the install. It becomes the Radar `userId`, and both fences are scoped to it, so crossings only fire for this device.

Native SDKs: iOS `RadarSDK`, Android `io.radar:sdk`, React Native `react-native-radar`, Flutter `flutter_radar`. Use SDK 3.16 or newer so tracking options (including offline replay) can be set from the Radar dashboard.

Use the Radar SDK as the app's **only** location source. Running a second location tracker next to it roughly doubles the battery cost.

---

## 2. Conventions

### Base URL

| Environment | Base URL |
|---|---|
| Local dev, same machine | `http://localhost:3000` |
| Local dev, physical phone on the same Wi-Fi | `http://<dev-machine-LAN-IP>:3000` (shown as "Network" when `npm run dev` starts) |
| Android emulator | `http://10.0.2.2:3000` |
| iOS simulator | `http://localhost:3000` |

> Android blocks plain `http://` by default. For local development, allow cleartext traffic for the dev host in your network security config. iOS needs an App Transport Security exception for the same reason.

### Requests

- Every body is JSON. Send `Content-Type: application/json`.
- **No authentication in this POC.** Don't send credentials. Auth will be added before production, so keep your HTTP client ready to attach a header later.
- Paths are case-sensitive.

### Responses

- Every response is JSON.
- Failed requests return `success: false` and a readable `error` string:

  ```json
  { "success": false, "error": "location.latitude must be a number between -90 and 90." }
  ```

  The `error` text is for logs and debugging. Branch on the **HTTP status code**, not on the text.

### Data types

| Type | Format | Example |
|---|---|---|
| Session id | UUID string, issued by the server | `"f61e6baf-e426-46ca-8fff-7243ae3d5cdd"` |
| Location id / event id | String, 1–100 chars, **generated on the device**. Use a UUID v4. | `"0d5c3c3e-8d0f-4b8a-9d8e-2f5e9c1a7b11"` |
| Latitude | JSON **number**, −90 to 90 | `21.1702` |
| Longitude | JSON **number**, −180 to 180 | `72.8311` |
| Timestamp | ISO 8601 string in **UTC** with a `Z` suffix | `"2026-09-28T08:32:00.000Z"` |
| Distance | JSON **integer**, meters, 0 to 20,000,000 | `112400` |

- Coordinates are stored to 7 decimal places (about 1 cm). Extra precision is rounded.
- Coordinates must be numbers. `"21.1702"` as a string is rejected.
- Always send timestamps in UTC with `Z`. A timestamp with no offset is read in the **server's** time zone, which will misplace the point.

---

## 3. Endpoints

### 3.1 Start a session

```http
POST /api/tracking/sessions
```

Call this when the user taps **Start**. Each call creates a **new** session; nothing is resumed.

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `deviceId` | string | yes | 1–200 characters, whitespace trimmed. A stable identifier for this install or device. |
| `start` | object | yes | Where the trip starts, and the geofence around it. |
| `start.latitude` | number | yes | Centre, −90 to 90 |
| `start.longitude` | number | yes | Centre, −180 to 180 |
| `start.radiusMeters` | integer | yes | 50–10,000. Below ~50 m normal GPS drift causes false exits; 10 km is Radar's limit. |
| `destination` | object | yes | Where the trip ends, and the geofence around it. Same three fields and rules as `start`. |
| `distanceMeters` | integer | yes | The planned trip distance from the Google route, in meters. |
| `eta` | string | yes | The estimated arrival time from the Google route. ISO 8601 UTC. |

```json
{
  "deviceId": "device-123",
  "start":       { "latitude": 21.1702, "longitude": 72.8311, "radiusMeters": 300 },
  "destination": { "latitude": 22.3072, "longitude": 73.1812, "radiusMeters": 500 },
  "distanceMeters": 112400,
  "eta": "2026-09-28T11:05:00.000Z"
}
```

**Response — `201 Created`**

```json
{
  "sessionId": "f61e6baf-e426-46ca-8fff-7243ae3d5cdd",
  "status": "ACTIVE",
  "startedAt": "2026-09-28T09:12:41.272Z",
  "start":       { "latitude": 21.1702, "longitude": 72.8311, "radiusMeters": 300 },
  "destination": { "latitude": 22.3072, "longitude": 73.1812, "radiusMeters": 500 },
  "distanceMeters": 112400,
  "eta": "2026-09-28T11:05:00.000Z",
  "radar": {
    "userId": "device-123",
    "startGeofenceTag": "tms-track-start",
    "destinationGeofenceTag": "tms-track-dest",
    "geofenceExternalId": "f61e6baf-e426-46ca-8fff-7243ae3d5cdd"
  }
}
```

Store `sessionId` durably, not only in memory. Every later call needs it, and it must survive the app being killed while tracking.

By the time this returns, Radar already has both fences for this `deviceId`. Then start tracking:

```text
Radar.startTracking(<continuous / responsive preset>)
```

**Don't register OS geofences and don't report crossings.** Radar decides inside and outside and tells the server by webhook. The `radar` block is for reference: if you show crossings in the app from the SDK's event listener, a fence with one of those tags and `externalId` equal to `sessionId` belongs to this session.

The start, destination and fences are fixed for the life of the session. There's no endpoint to change them. Distance and ETA updates go with each location instead (see [Send one location](#32-send-one-location)).

**Errors**

| Status | When |
|---|---|
| 400 | `deviceId` missing, empty, not a string, or over 200 characters; `start` or `destination` missing, not an object, or any of its three fields missing or out of range; `distanceMeters` missing or not a whole number ≥ 0; `eta` missing or not a timestamp; or the body isn't valid JSON. |
| 502 | A Radar call failed while creating the fences. Nothing was created. Safe to retry. |
| 503 | Radar isn't configured on the server. |

**Example**

```bash
curl -X POST http://localhost:3000/api/tracking/sessions \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"device-123","start":{"latitude":21.1702,"longitude":72.8311,"radiusMeters":300},"destination":{"latitude":22.3072,"longitude":73.1812,"radiusMeters":500},"distanceMeters":112400,"eta":"2026-09-28T11:05:00.000Z"}'
```

---

### 3.2 Send one location

```http
POST /api/tracking/sessions/{sessionId}/locations
```

Call this for each location from the Radar SDK's location listener (iOS `didUpdateLocation`, Android `RadarReceiver.onLocationUpdated`, React Native `Radar.on('location', …)`) while online, about every 2 minutes.

**Path parameters**

| Name | Description |
|---|---|
| `sessionId` | From [Start a session](#31-start-a-session). |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Generated on the device (UUID v4), 1–100 characters. **Generate it once, when the fix is taken, and reuse it on every retry.** |
| `latitude` | number | yes | −90 to 90 |
| `longitude` | number | yes | −180 to 180 |
| `capturedAt` | string | yes | When the GPS fix was taken (the SDK location's timestamp), not when it's sent. ISO 8601 UTC. |
| `remainingDistanceMeters` | integer or `null` | no | The remaining distance to the destination from the latest Google route, in meters. |
| `eta` | string or `null` | no | The ETA from the latest Google route. ISO 8601 UTC. |

```json
{
  "id": "0d5c3c3e-8d0f-4b8a-9d8e-2f5e9c1a7b11",
  "latitude": 21.1702,
  "longitude": 72.8311,
  "capturedAt": "2026-09-28T08:32:00.000Z",
  "remainingDistanceMeters": 84200,
  "eta": "2026-09-28T10:48:00.000Z"
}
```

`remainingDistanceMeters` and `eta` are optional: leave them out (or send `null`) when the phone has no route yet, and the location is still stored. If you send them they must be valid, or the request is rejected.

Attach them **when the fix is taken** and store them with the queued point, so an offline point carries the values from that moment. The web map shows the figures from the point with the newest `capturedAt`, so a late offline batch never overwrites a fresher live ETA.

**Don't call Google on every fix.** Each Routes API call is billed. Recompute every few minutes (or when the driver leaves the route) and attach the latest figures to the fixes in between. Offline, keep attaching the last figures you have.

**Response — `200 OK`**

```json
{ "success": true, "duplicate": false }
```

| Field | Meaning |
|---|---|
| `duplicate` | `true` if a location with this `id` was already stored, so nothing new was written. That's the expected result of a retry. Treat it as success. |

**Errors**

| Status | When |
|---|---|
| 400 | Invalid body. The `error` names the field, e.g. `location.capturedAt must be an ISO 8601 timestamp.` |
| 404 | No session with this `sessionId`. |

**Example**

```bash
curl -X POST http://localhost:3000/api/tracking/sessions/$SESSION_ID/locations \
  -H "Content-Type: application/json" \
  -d '{"id":"0d5c3c3e-8d0f-4b8a-9d8e-2f5e9c1a7b11","latitude":21.1702,"longitude":72.8311,"capturedAt":"2026-09-28T08:32:00.000Z"}'
```

---

### 3.3 Upload queued locations (bulk)

```http
POST /api/tracking/sessions/{sessionId}/locations/bulk
```

Call this when the connection comes back, to upload everything queued while offline.

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `locations` | array | yes | 1–**1,000** items. Each item has the same shape as [one location](#32-send-one-location), including the optional `remainingDistanceMeters` and `eta`. |

```json
{
  "locations": [
    {
      "id": "7b6f1f0a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
      "latitude": 21.1702,
      "longitude": 72.8311,
      "capturedAt": "2026-09-28T08:32:00.000Z",
      "remainingDistanceMeters": 84200,
      "eta": "2026-09-28T10:48:00.000Z"
    },
    {
      "id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      "latitude": 21.1710,
      "longitude": 72.8320,
      "capturedAt": "2026-09-28T08:34:00.000Z",
      "remainingDistanceMeters": 83950,
      "eta": "2026-09-28T10:49:00.000Z"
    }
  ]
}
```

**Response — `200 OK`**

```json
{ "success": true, "inserted": 2, "skipped": 0 }
```

| Field | Meaning |
|---|---|
| `inserted` | Locations newly stored. |
| `skipped` | Locations whose `id` was already stored. Resending a batch the server already has returns `inserted: 0` and `skipped` equal to the batch size. That's still a success. |

**Behaviour to rely on**

- **Idempotent.** Resending the same batch never creates duplicates. If the request times out or the response is lost, send the same batch again.
- **All-or-nothing validation.** If any item is invalid, the whole batch gets a `400` and **nothing** is stored. The error names the bad item, e.g. `locations[17].latitude must be a number between -90 and 90.`
- **Order doesn't matter.** The server orders the route by `capturedAt`, so queued points slot in at the right place even if uploaded late or out of order.
- **Stopped sessions still accept uploads.** If the user tapped Stop while offline, upload the queue afterwards. Those points still belong to the route.
- **More than 1,000 queued?** Split the queue into batches of 1,000 or fewer and send them one after another.

**Errors**

| Status | When |
|---|---|
| 400 | `locations` missing, empty, or over 1,000 items; or any item is invalid. |
| 404 | No session with this `sessionId`. |

**Example**

```bash
curl -X POST http://localhost:3000/api/tracking/sessions/$SESSION_ID/locations/bulk \
  -H "Content-Type: application/json" \
  -d '{"locations":[{"id":"7b6f1f0a-1c2d-4e3f-8a9b-0c1d2e3f4a5b","latitude":21.1702,"longitude":72.8311,"capturedAt":"2026-09-28T08:32:00.000Z"}]}'
```

---

### 3.4 Report geofence events (legacy)

```http
POST /api/tracking/sessions/{sessionId}/geofence-events
```

> **Don't call this from a current app build.** Crossings now come from Radar by webhook. The endpoint is kept only so an app built before Radar keeps working. Calling it as well would store every crossing twice, once from Radar and once from the app.

The rest of this section documents the old behaviour for reference.

The device reported entering or leaving the start or destination geofence. **One endpoint for live and offline:** a single crossing as soon as it happens, or the whole queue once the connection is back.

Typically an `EXIT` from `START` means the trip has begun, and an `ENTER` into `DESTINATION` means it has arrived. The server stores both kinds as reported and doesn't act on them.

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `events` | array | yes | 1–**1,000** items. |
| `events[].id` | string | yes | Generated on the device (UUID v4), 1–100 characters. **Generate it once, when the crossing is detected, and reuse it on every retry.** |
| `events[].type` | string | yes | `"ENTER"` or `"EXIT"` (upper case). |
| `events[].target` | string | yes | Which fence was crossed: `"START"` or `"DESTINATION"` (upper case). |
| `events[].capturedAt` | string | yes | When the crossing was detected, not when it's sent. ISO 8601 UTC. |
| `events[].isOffline` | boolean | yes | `true` if the event waited in the offline queue, `false` for a live send. Required; there's no default. |

```json
{
  "events": [
    { "id": "3f1c9a2e-6b7d-4c8e-9f0a-1b2c3d4e5f60", "type": "EXIT",  "target": "START",       "capturedAt": "2026-09-30T09:50:12.000Z", "isOffline": true },
    { "id": "8a2d4b6c-1e3f-4a5b-8c7d-9e0f1a2b3c4d", "type": "ENTER", "target": "DESTINATION", "capturedAt": "2026-09-30T11:05:40.000Z", "isOffline": false }
  ]
}
```

**Response — `200 OK`**

```json
{ "success": true, "inserted": 2, "skipped": 0 }
```

`inserted` and `skipped` mean the same as for [bulk locations](#33-upload-queued-locations-bulk).

**Behaviour to rely on**

- **Idempotent** on event `id`. Resending a batch never creates duplicates.
- **All-or-nothing validation.** One invalid event rejects the batch, and the error names it, e.g. `events[3].type must be "ENTER" or "EXIT".`
- **Stored as reported.** The server doesn't check events against the fence, the route or each other. Two `EXIT`s in a row are stored as two `EXIT`s.
- **Order doesn't matter.** The web map orders events by `capturedAt`, so a late offline `EXIT` shows up in the right place.
- **Stopped sessions still accept events**, so a queue flushed after Stop isn't lost.

**Errors**

| Status | When |
|---|---|
| 400 | `events` missing, empty, or over 1,000 items; or any event is invalid. |
| 404 | No session with this `sessionId`. |
| 409 | The session has no fence for an event's `target`. Only sessions created before start/destination existed can lack one. Don't retry. |

**Example**

```bash
curl -X POST http://localhost:3000/api/tracking/sessions/$SESSION_ID/geofence-events \
  -H "Content-Type: application/json" \
  -d '{"events":[{"id":"3f1c9a2e-6b7d-4c8e-9f0a-1b2c3d4e5f60","type":"EXIT","target":"START","capturedAt":"2026-09-30T09:50:12.000Z","isOffline":false}]}'
```

---

### 3.5 Stop a session

```http
POST /api/tracking/sessions/{sessionId}/stop
```

Call this when the user taps **Stop**. No request body. The server also deletes both Radar fences; a Radar failure there doesn't fail the stop.

**Response — `200 OK`**

```json
{
  "success": true,
  "sessionId": "f61e6baf-e426-46ca-8fff-7243ae3d5cdd",
  "status": "COMPLETED",
  "endedAt": "2026-09-28T09:12:47.891Z"
}
```

**Errors**

| Status | When | Body |
|---|---|---|
| 404 | No session with this `sessionId`. | `{ "success": false, "error": "Tracking session not found." }` |
| 409 | The session was already stopped. | Same fields as a success, plus `success: false` and an `error`. `status` is `COMPLETED` and `endedAt` is the original stop time. |

A `409` means the session is already where you wanted it. If the device is retrying a Stop whose response was lost, treat `409` as success.

**Example**

```bash
curl -X POST http://localhost:3000/api/tracking/sessions/$SESSION_ID/stop
```

---

## 4. Status codes at a glance

| Status | Meaning | What the app should do |
|---|---|---|
| 200 / 201 | Success, including `duplicate: true` and `skipped > 0` | Remove the sent points from the queue. |
| 400 | The request is malformed | **Don't retry the same payload.** It will fail the same way. Log the `error`; this is a bug in the app. |
| 404 | The session doesn't exist | Stop sending for this session. Discard its queue and log it. |
| 409 | Stop called on a session that's already stopped | Treat as success. |
| 502 | Start couldn't create the Radar fences | Nothing was created. Retry Start; don't start tracking without a `sessionId`. |
| 503 | Start called while Radar isn't configured on the server | Server setup problem. Report it; retrying won't help until it's fixed. |
| 5xx, timeout, no network | Server or network problem | **Keep the points queued** and retry with backoff. Retries are safe because location ids make them idempotent. |

---

## 5. Integration guide

### 5.1 Recommended device logic

```text
on app launch:
    Radar.initialize(pk); Radar.setUserId(deviceId); Radar.trackOnce()

on Start tap:
    route = Google Routes API: start → destination   // distance + ETA
    { sessionId } = POST /sessions
        { deviceId, start, destination, distanceMeters: route.distance, eta: route.eta }
    save sessionId to persistent storage
    Radar.startTracking(preset)                      // offline replay is set from the dashboard

every few minutes while tracking (and when online):
    progress = Google Routes API: current position → destination
    // offline: keep the last progress you had

on each Radar SDK location (listener):
    point = { id: newUUID(), latitude, longitude, capturedAt: location.timestamp,
              remainingDistanceMeters: progress?.distance, eta: progress?.eta }
    append point to persistent queue            // always queue first

geofence crossings:
    nothing to send — Radar reports them to the server.
    Optionally show them in the app from the SDK's event listener.

on each send opportunity (new fix, connectivity restored, app resumed):
    if offline: do nothing
    if queue has 1 point:  POST /locations      with that point
    if queue has >1 point: POST /locations/bulk with up to 1,000 points
    on 200: remove exactly those point ids from the queue
    on 400: log; move the batch aside so it doesn't block the queue
    on 404: log; clear the queue for this session
    on 5xx / network error: keep the queue, retry with backoff

on Stop tap:
    Radar.stopTracking()
    flush the location queue (as above), then POST /stop   // the server deletes the fences
    if offline: remember "stop pending" and send it after the queue is flushed
    on 200 or 409: clear sessionId
```

### 5.2 Rules that keep the data correct

1. **Generate the location `id` once, when the fix is taken**, and store it with the point. A new id on each retry defeats duplicate protection and stores the point twice.
2. **Location ids must be globally unique**, not just unique within a session. If an id already exists in any session, the new point is silently skipped. UUID v4 avoids this.
3. **`capturedAt` is the GPS fix time**, not the send time. Offline points must keep their original capture time; the web map uses it to draw the route and to mark the point as an offline upload.
4. **Only remove points from the queue after a `200`.** A timeout doesn't mean the server didn't store them; resending is always safe.
5. **Keep the queue and the current `sessionId` in persistent storage** (SQLite, Room, Core Data, MMKV, etc.) so a crash or OS kill doesn't lose points.

### 5.3 Send frequency

| | Interval |
|---|---|
| GPS fix and send, device | about every **2 minutes** |
| Google Routes API recompute, device | every **few minutes**, or when the driver leaves the route |
| Web map refresh (for reference only) | every 5 seconds |

These are independent. Sending more often than every 2 minutes works, but isn't needed for the POC.

---

## 6. End-to-end smoke test

Run these in order against a running dev server (`npm run dev`) with the Radar keys configured. They cover every mobile endpoint, including a retried bulk upload. Geofence crossings need a real Radar track, so they aren't part of this test; use the simulator (below) for those.

```bash
BASE=http://localhost:3000/api/tracking/sessions

# 1. Start a trip
SESSION_ID=$(curl -s -X POST $BASE -H "Content-Type: application/json" \
  -d '{"deviceId":"smoke-test",
       "start":{"latitude":21.1702,"longitude":72.8311,"radiusMeters":300},
       "destination":{"latitude":21.1832,"longitude":72.8441,"radiusMeters":300},
       "distanceMeters":1950,"eta":"2026-09-28T08:50:00.000Z"}' \
  | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')
echo "session: $SESSION_ID"

# 2. One live location, with remaining distance and ETA
curl -s -X POST $BASE/$SESSION_ID/locations -H "Content-Type: application/json" \
  -d '{"id":"'$SESSION_ID'-1","latitude":21.1702,"longitude":72.8311,"capturedAt":"2026-09-28T08:32:00.000Z","remainingDistanceMeters":1950,"eta":"2026-09-28T08:50:00.000Z"}'
# → {"success":true,"duplicate":false}

# 3. Offline batch, then the same batch again
BATCH='{"locations":[
  {"id":"'$SESSION_ID'-2","latitude":21.1730,"longitude":72.8340,"capturedAt":"2026-09-28T08:34:00.000Z","remainingDistanceMeters":1540,"eta":"2026-09-28T08:51:00.000Z"},
  {"id":"'$SESSION_ID'-3","latitude":21.1760,"longitude":72.8370,"capturedAt":"2026-09-28T08:36:00.000Z","remainingDistanceMeters":1120,"eta":"2026-09-28T08:52:00.000Z"}]}'
curl -s -X POST $BASE/$SESSION_ID/locations/bulk -H "Content-Type: application/json" -d "$BATCH"
# → {"success":true,"inserted":2,"skipped":0}
curl -s -X POST $BASE/$SESSION_ID/locations/bulk -H "Content-Type: application/json" -d "$BATCH"
# → {"success":true,"inserted":0,"skipped":2}

# 4. Stop, then stop again
curl -s -X POST $BASE/$SESSION_ID/stop
# → {"success":true,...,"status":"COMPLETED",...}
curl -s -w " HTTP %{http_code}\n" -X POST $BASE/$SESSION_ID/stop
# → {"success":false,"error":"Tracking session is not active.",...} HTTP 409
```

Then open `http://localhost:3000/tracking` in a signed-in browser to see the session and its route. `http://localhost:3000/tracking/simulator` drives the same endpoints from the browser and sends each position to real Radar, so you can see crossings arrive by webhook. It has an offline mode too, but the web SDK can't replay offline positions to Radar the way the phone SDK does.

---

## 7. POC limitations

These will change before production. Don't build anything that depends on them staying as they are.

- **No authentication.** Anyone who can reach the server can call these endpoints.
- **No rate limiting.**
- **No link to shipments or drivers.** A session knows only its `deviceId`.
- Accuracy, speed, heading and battery fields aren't accepted yet; extra fields in the body are ignored.
- **Two circular geofences per session** (start and destination), set at Start and never changed, at most 10 km in radius. The map lists crossings rather than pinning them on the route.
- **Crossings depend on Radar's webhook reaching the server**, with `user.entered_geofence` and `user.exited_geofence` enabled in the Radar dashboard (setup: [radar-tracking-poc.md §4](./radar-tracking-poc.md#4-radar-setup-dashboard-once)). They typically arrive within seconds. A crossing made offline arrives when the SDK replays it, marked as an offline event.
- **Distance and ETA are the phone's Google figures**, stored as reported. The server doesn't recalculate or check them. Google has no truck routing mode, so the ETA is for a car.
