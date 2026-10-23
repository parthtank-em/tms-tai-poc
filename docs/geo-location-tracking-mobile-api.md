# Geo Location Tracking — Mobile Integration Guide

For developers building the mobile app against the **geolocation tracking POC** (`/tracking`). It works exactly like the Radar POC ([radar-tracking-mobile-api.md](./radar-tracking-mobile-api.md)) — same flow, same request and response shapes — with one difference: **the planned route, distance and ETA come from the Google Routes API** (drive, with traffic) instead of Radar's route API. The paths are `/api/tracking/sessions/…` and a trip is called a *session*; the two POCs share no data.

Design background: [geo-location-tracking-poc-implementation.md](./geo-location-tracking-poc-implementation.md) and [radar-tracking-poc.md](./radar-tracking-poc.md). Short step-by-step version of the app flow: [geo-location-tracking-mobile-flow.md](./geo-location-tracking-mobile-flow.md).

---

## 1. Who does what

| Concern | Who |
|---|---|
| Planning a trip: source, destination, geofence radius for each | **The web portal** (`/tracking` → Add trip). Optionally **the app** too, with `POST /sessions` |
| Listing trips and starting one | **The app**, from our API |
| Tracking location in the background, battery, offline replay | **Radar SDK** on the phone |
| Creating the trip's two geofences and the Radar trip | **Our backend**, on `POST /sessions/{id}/start` |
| Deciding when the device enters/exits the start and destination | **Radar** (server side, from the SDK's locations) |
| Trip status (started → approaching → arrived) and ETA | **Radar** (car mode) |
| The route line on our web map | **The app** forwards each SDK location to our backend |
| Completing the trip and removing the fences | **Our backend**, on `POST /sessions/{id}/stop` |

The app does **not** report geofence crossings, and does **not** compute distance or ETA.

### Trip lifecycle

```text
PLANNED  ── phone: POST /start ──►  ACTIVE  ── phone: POST /stop ──►  COMPLETED
(created on the portal or by        (this phone's trip;               (history)
 POST /sessions; can be edited or      fences exist in Radar)
 deleted on the portal)
```

A trip is always created **PLANNED**, wherever it comes from, and always started with `POST /start`. Radar's geofences only exist from Start to Stop.

A trip can be started **once**, by **any** phone. The first phone to start it owns it; anyone else gets `409`.

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

### Requests and responses

- JSON bodies with `Content-Type: application/json`, JSON responses.
- No authentication in this POC.
- Failed requests return `{ "success": false, "error": "…" }`. The `error` names the field (and the index, in a batch). Branch on the HTTP status, not the text.
- Timestamps are ISO 8601 UTC with `Z`. Coordinates are JSON numbers.
- Location ids are generated on the device (UUID v4), once per fix, and reused on every retry.

---

## 3. Radar SDK setup (once per app launch)

Use the Radar **test** publishable key (`prj_test_pk_…`) from the team.

```text
Radar.initialize(publishableKey)
Radar.setUserId(deviceId)          // the same deviceId you send to POST /start
request "Always" location permission (background location on Android)
Radar.trackOnce()                  // creates the Radar user before a trip names it
```

`deviceId` must be stable for the install. It becomes the Radar `userId`; the trip and both geofences are scoped to it when the phone starts the trip, so events only fire for this device.

Native SDK docs: iOS `RadarSDK`, Android `io.radar:sdk`, React Native `react-native-radar`, Flutter `flutter_radar`. Use SDK 3.16 or newer so tracking options (including offline replay) can be controlled from the Radar dashboard.

---

## 4. Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/tracking/sessions?status=PLANNED` | List trips the driver can start |
| GET | `/api/tracking/sessions/{sessionId}` | Trip detail |
| POST | `/api/tracking/sessions` | Create a trip (planned) — **optional** |
| POST | `/api/tracking/sessions/{sessionId}/start` | Start a trip |
| POST | `/api/tracking/sessions/{sessionId}/locations` | Forward one SDK location |
| POST | `/api/tracking/sessions/{sessionId}/locations/bulk` | Upload queued locations |
| POST | `/api/tracking/sessions/{sessionId}/stop` | Stop the trip |

> **Changed from the earlier /tracking POC:**
> - `POST /sessions` used to create **and start** a session from `deviceId`, `start`, `destination`, `distanceMeters` and `eta`. It now only creates a **planned** session from `start` and `destination` (the server gets the route from Google; the other fields are ignored). Starting is `POST /sessions/{sessionId}/start`, which now also creates a Radar trip.
> - The phone **no longer calls Google** for distance and ETA while driving, and no longer sends `remainingDistanceMeters` / `eta` with locations (they are ignored). The live ETA comes from Radar. Locations take an optional `accuracy` instead.
> - `POST /sessions/{sessionId}/geofence-events` (legacy) is **removed**. Radar reports crossings by webhook.

### The trip object

`GET /sessions` returns an array of these; `GET /sessions/{sessionId}` returns one.

```json
{
  "id": "f61e6baf-e426-46ca-8fff-7243ae3d5cdd",
  "status": "PLANNED",
  "deviceId": null,
  "createdAt": "2026-10-23T08:40:12.118Z",
  "startedAt": null,
  "endedAt": null,
  "start": {
    "address": "Surat Railway Station, Railway Station Area, Varachha, Surat, Gujarat 395003, India",
    "latitude": 21.2049,
    "longitude": 72.8411,
    "radiusMeters": 300
  },
  "destination": {
    "address": null,
    "latitude": 22.3072,
    "longitude": 73.1812,
    "radiusMeters": 500
  },
  "planned": { "distanceMeters": 142508, "durationMinutes": 165.3 },
  "tripStatus": null,
  "eta": null,
  "radarUpdatedAt": null,
  "departedAt": null,
  "arrivedAt": null,
  "radarSyncError": null,
  "locationCount": 0,
  "eventCount": 0
}
```

| Field | Notes |
|---|---|
| `status` | Our lifecycle: `PLANNED`, `ACTIVE` or `COMPLETED`. Only `PLANNED` trips can be started. |
| `deviceId`, `startedAt` | `null` until a phone starts the trip. |
| `start.address`, `destination.address` | The address picked when the trip was planned (on the portal from Google Places, or sent by the app on `POST /sessions`). `null` when the point was entered as latitude/longitude — show the coordinates instead. |
| `planned` | Google's drive route (with traffic) from when the session was planned: distance in meters, travel time in minutes. For display only; the live ETA after Start is `eta`, which is Radar's **car** ETA. Can be `null` for sessions from before planning. |
| `tripStatus`, `eta`, `departedAt`, `arrivedAt` | Filled in by Radar after Start (by webhook). `eta.minutes` is the remaining travel time. |

### 4.1 List trips

```http
GET /api/tracking/sessions?status=PLANNED
```

Newest first. `status` is optional (`PLANNED`, `ACTIVE`, `COMPLETED`, any case); without it every trip is returned. For the driver's "trips to start" screen use `status=PLANNED`.

| Status | When |
|---|---|
| 200 | An array, possibly empty. |
| 400 | `status` is not one of the three values. |

### 4.2 Trip detail

```http
GET /api/tracking/sessions/{sessionId}
```

| Status | When |
|---|---|
| 200 | The trip object. |
| 404 | No such trip (for example, deleted on the portal). |

### 4.3 Create a trip (optional)

```http
POST /api/tracking/sessions
```

> **Optional for the app.** Trips are normally planned on the web portal, and the app only lists and starts them. Implement this only if drivers should also be able to plan a trip on the phone; the rest of the flow works without it.

For a driver who plans the trip on the phone rather than picking one from the portal. The server computes Google's drive route (with traffic) and saves the session as `PLANNED`; nothing is created in Radar until Start.

| Field | Type | Required | Notes |
|---|---|---|---|
| `start` | object | yes | Where the trip starts, and the geofence around it. |
| `start.latitude` | number | yes | −90 to 90 |
| `start.longitude` | number | yes | −180 to 180 |
| `start.radiusMeters` | integer | yes | 50–10,000. Below ~50 m GPS drift causes false exits; 10 km is Radar's limit. |
| `start.address` | string or `null` | no | Up to 500 chars, shown in the trip list. Leave it out or `null` for a point picked on a map or typed as coordinates. |
| `destination` | object | yes | Same four fields and rules as `start`. |

```json
{
  "start":       { "address": "Surat Railway Station, Railway Station Area, Varachha, Surat, Gujarat 395003, India", "latitude": 21.2049, "longitude": 72.8411, "radiusMeters": 300 },
  "destination": { "latitude": 22.3072, "longitude": 73.1812, "radiusMeters": 500 }
}
```

**Response — `201 Created`:** the [trip object](#the-trip-object), with `status: "PLANNED"` and `planned` filled in. Keep its `id`, then call [Start](#44-start-a-trip).

| Status | When |
|---|---|
| 400 | Invalid body; the `error` names the field, e.g. `destination.radiusMeters must be a whole number between 50 and 10000.` |
| 502 | Google could not route between the two points (or the call failed). Nothing was saved. Check the points; retrying is safe. |
| 503 | Radar keys (Start) or the Google routing key (Create) are not configured on the server. |

Not idempotent: each successful call creates a new trip. If the response is lost, look for the trip in `GET /sessions?status=PLANNED` before sending again.

Our API has no address search. The portal uses Google Places Autocomplete; for matching addresses, use the Google Places SDK on the phone too and send the picked address and coordinates.

### 4.4 Start a trip

```http
POST /api/tracking/sessions/{sessionId}/start
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `deviceId` | string | yes | 1–200 chars. Must match `Radar.setUserId`. |

```json
{ "deviceId": "device-123" }
```

**Response — `200 OK`**

```json
{
  "sessionId": "f61e6baf-e426-46ca-8fff-7243ae3d5cdd",
  "status": "ACTIVE",
  "tripStatus": "STARTED",
  "startedAt": "2026-10-23T09:12:41.272Z",
  "start":       { "address": "Surat Railway Station, Railway Station Area, Varachha, Surat, Gujarat 395003, India", "latitude": 21.2049, "longitude": 72.8411, "radiusMeters": 300 },
  "destination": { "address": null, "latitude": 22.3072, "longitude": 73.1812, "radiusMeters": 500 },
  "planned": { "distanceMeters": 142508, "durationMinutes": 165.3 },
  "radar": {
    "userId": "device-123",
    "externalId": "tms-track-f61e6baf-e426-46ca-8fff-7243ae3d5cdd",
    "mode": "car",
    "startGeofenceTag": "tms-track-start",
    "destinationGeofenceTag": "tms-track-dest",
    "destinationGeofenceExternalId": "f61e6baf-e426-46ca-8fff-7243ae3d5cdd"
  }
}
```

By the time this returns, Radar already has both geofences and an active trip for this user. Store `sessionId` durably. Then start tracking:

```text
Radar.startTracking(<trip / continuous preset>)
```

Optionally, to get the SDK's trip-aware behaviour, call `Radar.startTrip` with the values from `radar` (`externalId`, `destinationGeofenceTag`, `destinationGeofenceExternalId`, `mode`). Radar matches trips on `externalId`, so this attaches to the trip the server created rather than making a second one.

| Status | When |
|---|---|
| 400 | `deviceId` missing or invalid. |
| 404 | No such trip. Refresh the list. |
| 409 | The trip was already started (by this or another phone) or is completed. The body has `success: false`, `status`, `deviceId` and `startedAt`. If `deviceId` is yours, a previous Start succeeded and its response was lost: carry on tracking. Otherwise refresh the list. |
| 502 | A Radar call failed. The trip is back to `PLANNED` and nothing was left in Radar. Safe to retry. |
| 503 | Radar keys (Start) or the Google routing key (Create) are not configured on the server. |

### 4.5 Forward one location

```http
POST /api/tracking/sessions/{sessionId}/locations
```

Call from the SDK's location listener (iOS `didUpdateLocation`, Android `RadarReceiver.onLocationUpdated`, RN `Radar.on('location', …)`).

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Device-generated UUID (at most 100 chars), reused on retry. |
| `latitude` | number | yes | −90 to 90 |
| `longitude` | number | yes | −180 to 180 |
| `accuracy` | number or `null` | no | Meters, from the SDK location; 0–100,000 when present. |
| `capturedAt` | string | yes | The fix time from the SDK location, not the send time. |

**Response — `200 OK`:** `{ "success": true, "duplicate": false }`. `duplicate: true` means it was already stored; treat it as success.

| Status | When |
|---|---|
| 400 | Invalid body; the `error` names the field. Retrying the same point won't help. |
| 404 | No such trip. Drop the queued points for it. |
| 409 | The trip has not been started. Call `POST /start` first. |

A **stopped trip still accepts locations**, so points queued while offline can be uploaded after Stop.

### 4.6 Upload queued locations

```http
POST /api/tracking/sessions/{sessionId}/locations/bulk
```

`{ "locations": [ … ] }`, 1–1,000 items of the shape above. Idempotent on `id`. Response: `{ "success": true, "inserted": 2, "skipped": 0 }` (`skipped` counts ids already stored).

| Status | When |
|---|---|
| 400 | Empty array, more than 1,000 items, or any invalid item. Validation is all-or-nothing: one bad point rejects the whole batch and nothing is stored. The `error` names the index, e.g. `locations[3].capturedAt …`. |
| 404 | No such trip. Drop the queued points for it. |
| 409 | The trip has not been started. |

As with a single location, a stopped trip still accepts the batch.

This queue is **only for our route line**. Radar receives the offline stretch through the SDK's own replay, independently.

### 4.7 Stop the trip

```http
POST /api/tracking/sessions/{sessionId}/stop
```

No body. Completes the Radar trip and deletes both geofences.

```json
{
  "success": true,
  "sessionId": "f61e6baf-e426-46ca-8fff-7243ae3d5cdd",
  "status": "COMPLETED",
  "tripStatus": "COMPLETED",
  "endedAt": "2026-10-23T10:30:00.000Z",
  "radarSyncError": null
}
```

A Radar failure does not fail the stop; it is reported in `radarSyncError`.

| Status | When |
|---|---|
| 409 | The trip is not active: already stopped (treat as success — the body has `success: false` plus the same fields as above), or never started. |
| 404 | No such trip. |

---

## 5. Recommended device logic

```text
on app launch:
    Radar.initialize(pk); Radar.setUserId(deviceId); Radar.trackOnce()

trip list screen:
    sessions = GET /sessions?status=PLANNED      // show start/destination address, planned distance and time

new trip screen (OPTIONAL — only if drivers plan trips on the phone; otherwise trips come from the portal):
    pick each end with Google Places autocomplete, a map tap or typed coordinates; set both radii
    session = POST /sessions { start, destination }   // 201 → PLANNED session; show it, then Start as below

trip detail screen:
    session = GET /sessions/{sessionId}

on Start tap:
    POST /sessions/{sessionId}/start { deviceId }
        200 → save sessionId to persistent storage; Radar.startTracking(trip preset)
        409 with your deviceId → same as 200 (an earlier Start succeeded)
        409 otherwise / 404 → "trip no longer available", refresh the list
        502 → nothing changed, let the driver retry

on each Radar SDK location (listener):
    point = { id: newUUID(), latitude, longitude, accuracy, capturedAt: location.timestamp }
    append point to persistent queue
    if online: POST /locations (1 point) or /locations/bulk (up to 1,000)
               on 200 remove those ids; on 5xx/network keep and retry with backoff
               on 400 move the batch aside; on 404 clear the queue for this trip
               on 409 the trip was never started — call POST /start before sending points

on Stop tap (or when you decide the trip is over):
    Radar.stopTracking()
    flush the queue, then POST /stop      // 200 or 409 → clear sessionId
```

Radar's own events (`entered_geofence`, `approaching_trip_destination`, `arrived_at_trip_destination`, …) also reach the app through the SDK's event listener if you want to show them on the phone. The server receives them by webhook regardless.

---

## 6. POC limitations

- No authentication or rate limiting on these endpoints. Any phone can list and start any planned trip.
- The live ETA is Radar's **car** ETA; Radar trips do not support a truck mode. The planned route (`planned`) is Google's, also by car.
- The trip is not linked to a shipment or driver — only to the `deviceId` that started it.
- One start and one destination per trip, fixed once the trip is started.
