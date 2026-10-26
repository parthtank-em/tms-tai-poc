# Geo Location Tracking — Mobile Integration Guide

For developers building the mobile app against the **geolocation tracking POC** (`/tracking`). It works exactly like the Radar POC ([radar-tracking-mobile-api.md](./radar-tracking-mobile-api.md)) — same flow, same request and response shapes — with one difference: **the planned route, distance and ETA come from the Google Routes API** (drive, with traffic) instead of Radar's route API. The paths are `/api/tracking/sessions/…` and a trip is called a *session*; the two POCs share no data.

On top of that, this POC adds **rerouting**: the app draws the route to follow (`GET /route`), checks each GPS fix against it, and when the driver leaves it asks the server for a new one (`POST /reroute`); the server routes again with Google and the dashboard shows the new route. The dashboard can also show the driven line snapped to roads (Google Roads API, on when `GOOGLE_ROADS_ENABLED=true`) — nothing for the app to do there either way.

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
| GET | `/api/tracking/sessions/{sessionId}/route` | The route to follow now (to draw) |
| POST | `/api/tracking/sessions/{sessionId}/reroute` | The phone left the route — get a new one |
| GET | `/api/tracking/sessions/{sessionId}/weather` | Weather alerts on the route ahead (to notify the driver) |

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
  "eventCount": 0,
  "routeVersion": 1,
  "reroutedAt": null,
  "rerouted": null,
  "drivenRouteError": null,
  "weatherVersion": 0,
  "weatherCheckedAt": null,
  "weatherError": null
}
```

| Field | Notes |
|---|---|
| `status` | Our lifecycle: `PLANNED`, `ACTIVE` or `COMPLETED`. Only `PLANNED` trips can be started. |
| `deviceId`, `startedAt` | `null` until a phone starts the trip. |
| `start.address`, `destination.address` | The address picked when the trip was planned (on the portal from Google Places, or sent by the app on `POST /sessions`). `null` when the point was entered as latitude/longitude — show the coordinates instead. |
| `planned` | Google's drive route (with traffic) from when the session was planned: distance in meters, travel time in minutes. For display only; the live ETA after Start is `eta`, which is Radar's **car** ETA. Can be `null` for sessions from before planning. |
| `tripStatus`, `eta`, `departedAt`, `arrivedAt` | Filled in by Radar after Start (by webhook). `eta.minutes` is the remaining travel time. |
| `routeVersion` | The route to follow now: 1 = planned, each reroute adds one. Fetch [`/route`](#48-get-the-route-to-follow) when it is higher than yours. |
| `reroutedAt`, `rerouted` | When the driver was last rerouted, and that route's `distanceMeters` / `durationMinutes`. `null` until the first reroute. |
| `drivenRouteError` | Dashboard only: the last failure snapping the driven line to roads. Ignore on the phone. |
| `weatherVersion` | Goes up when there are new weather alerts on the route ahead (0 = none yet). Fetch [`/weather`](#410-get-the-weather-ahead) when it is higher than yours. |
| `weatherCheckedAt`, `weatherError` | When the road ahead was last checked for weather, and the last failure doing so. For display only. |

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
| 503 | The Google routing key is not configured on the server. |

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
| 409 | The trip was already started (by this or another phone) or is completed. The body has `success: false`, `error`, `sessionId`, `status`, `deviceId` and `startedAt`. If `deviceId` is yours, a previous Start succeeded and its response was lost: carry on tracking. Otherwise refresh the list. |
| 502 | A Radar call failed. The trip is back to `PLANNED` and nothing was left in Radar. Safe to retry. |
| 503 | The Radar keys are not configured on the server. |

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

**Response — `200 OK`:** `{ "success": true, "duplicate": false, "routeVersion": 1, "weatherVersion": 0 }`. `duplicate: true` means it was already stored; treat it as success. `routeVersion` is the route to follow now — if it is higher than the version you are drawing, fetch [`/route`](#48-get-the-route-to-follow). `weatherVersion` works the same way for weather alerts — if it is higher than yours, fetch [`/weather`](#410-get-the-weather-ahead).

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

`{ "locations": [ … ] }`, 1–1,000 items of the shape above. Idempotent on `id`. Response: `{ "success": true, "inserted": 2, "skipped": 0, "routeVersion": 1, "weatherVersion": 0 }` (`skipped` counts ids already stored; `routeVersion` and `weatherVersion` as for a single location).

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

### 4.8 Get the route to follow

```http
GET /api/tracking/sessions/{sessionId}/route
```

The route the driver should follow now, to draw on the phone's map. Version 1 is the route planned on the portal (Google); after a reroute it is the new route.

```json
{
  "route": {
    "version": 1,
    "source": "PLANNED",
    "distanceMeters": 142508,
    "durationMinutes": 165.3,
    "polyline": "u~`aCcz~{L…",
    "updatedAt": "2026-10-23T08:30:00.000Z"
  }
}
```

| Field | Notes |
|---|---|
| `version` | 1 = planned; each reroute adds one. Keep it with the route you draw. |
| `source` | `PLANNED` or `REROUTE`. |
| `polyline` | Google encoded polyline (precision 5). Android: `PolyUtil.decode(polyline)`; iOS: `GMSPath(fromEncodedPath:)`. Draw it as the route line. |
| `distanceMeters`, `durationMinutes` | Google's drive figures for this route, from where it starts (the source, or where the driver was rerouted). |

`route` is `null` only if the session has no planned route. `404` if there is no such session.

Call it **after Start**, and **whenever a locations response's `routeVersion` is higher** than the version you are drawing (for example, a reroute response was lost).

### 4.9 Reroute (the phone left the route)

```http
POST /api/tracking/sessions/{sessionId}/reroute
```

The **phone** decides when the driver is off the route, by checking each GPS fix against the route it draws (see [5. Recommended device logic](#5-recommended-device-logic)). The **server** then asks the Google Routes API for a route from the driver's position to the destination and makes it the route to follow; the dashboard shows it on its next refresh. Only the latest reroute is kept.

| Field | Type | Required | Notes |
|---|---|---|---|
| `latitude`, `longitude` | number | yes | Where the driver is now. |
| `routeVersion` | integer | no | 1 or more: the version you were following. Send it — a request for an out-of-date version is not rerouted again. |

```json
{ "latitude": 21.1905, "longitude": 72.8602, "routeVersion": 1 }
```

**Response — `200 OK`:** `{ "success": true, "rerouted": true, "route": { …same shape as 4.8, version 2, source "REROUTE"… } }`. Draw the `route`.

`rerouted: false` means no new route was made — your version was already out of date, or the last reroute was under a minute ago — and `route` is the current one. Draw it anyway.

| Status | When |
|---|---|
| 400 | Invalid body. |
| 404 | No such session. |
| 409 | The session is not active (not started yet, or stopped). |
| 502 | Google could not route from that point. Nothing changed; keep the route you have and try again on a later fix. |
| 503 | Google routing is not configured on the server. |

### 4.10 Get the weather ahead

```http
GET /api/tracking/sessions/{sessionId}/weather
```

The server checks Google's hourly forecast at points along the route ahead of the driver: at Start, after each reroute, and every 30 minutes while the trip is active. It raises an **alert** for each hazard it finds: thunderstorm, heavy rain, snow/ice, strong wind, low visibility or extreme heat. The route itself never changes because of weather. Alerts are only warnings.

The phone finds out there is something new from `weatherVersion` in the [locations](#45-forward-one-location) response, and shows them as **local notifications**. No push service is involved.

```json
{
  "weather": {
    "version": 2,
    "routeVersion": 1,
    "checkedAt": "2026-10-26T09:30:04.112Z",
    "checkpoints": [
      {
        "latitude": 21.2049,
        "longitude": 72.8411,
        "distanceAheadMeters": 0,
        "expectedAt": "2026-10-26T09:30:04.000Z",
        "condition": "Light rain",
        "iconBaseUri": "https://maps.gstatic.com/weather/v1/showers",
        "temperatureC": 27.4,
        "precipitationPercent": 60,
        "hazards": []
      }
    ],
    "alerts": [
      {
        "id": "0b6c2f0e-7d1f-4f6a-9a51-3c1e2b9d8a10",
        "kind": "HEAVY_RAIN",
        "severity": "WARNING",
        "message": "Heavy rain (9 mm/h) expected 42 km ahead around 15:30",
        "condition": "Heavy rain",
        "latitude": 21.5402,
        "longitude": 72.9631,
        "distanceAheadMeters": 42000,
        "expectedAt": "2026-10-26T10:00:00.000Z",
        "routeVersion": 1,
        "createdAt": "2026-10-26T09:30:04.500Z"
      }
    ]
  }
}
```

| Field | Notes |
|---|---|
| `version` | Keep it. Fetch again when a locations response's `weatherVersion` is higher. |
| `alerts` | Alerts on the route to follow now whose `expectedAt` is less than an hour past, soonest first. **Notify each `id` once:** remember the ids you have shown, and don't show them again when they come back on a later fetch. After a reroute the list is the new route's. |
| `alerts[].message` | Ready to show as the notification text. The time is local to that place. `distanceAheadMeters` is measured from where the driver was when the server checked, so it gets out of date as the driver moves. Prefer `expectedAt` for anything you work out yourself. |
| `alerts[].kind`, `severity` | `kind`: `THUNDERSTORM`, `HEAVY_RAIN`, `SNOW_ICE`, `STRONG_WIND`, `LOW_VISIBILITY`, `EXTREME_HEAT`. `severity`: `WARNING` or `SEVERE`. For example, use a louder notification for `SEVERE`. |
| `checkpoints` | Optional to use: the forecast at up to 12 points ahead, nearest first, for a weather strip on the trip screen. Empty before the first check. `iconBaseUri` + `.svg` or `.png` is Google's icon. |

`404` if there is no such session. Before the first check (or when weather is turned off on the server) the response has `version: 0`, no alerts and no checkpoints.

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
              route = GET /sessions/{sessionId}/route   // draw route.polyline, keep route.version
              weatherVersion = 0; notifiedAlertIds = {}  // keep both in persistent storage too
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
               if response.routeVersion > route.version: route = GET /route, redraw
               if response.weatherVersion > weatherVersion:
                   w = GET /weather; weatherVersion = w.weather.version
                   for alert in w.weather.alerts where alert.id not in notifiedAlertIds:
                       show local notification (alert.message; louder if alert.severity == SEVERE)
                       add alert.id to notifiedAlertIds
                   optionally show w.weather.checkpoints as a weather strip

    off-route check (every fix, online or not — it is local and free):
    d = distance from the fix to route.polyline (nearest point on the line)
    if d > 250 m for 2 fixes in a row (ignore fixes with accuracy worse than 100 m):
        if online: r = POST /reroute { latitude, longitude, routeVersion: route.version }
                   on 200: route = r.route, redraw   // rerouted or not, draw what comes back
                   on 502 / network: keep the route, try again on a later fix
        offline:   keep the route; check again when back online

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
- Weather alerts reach the phone only through locations responses, so only while it is uploading. There are no push notifications: a phone that is offline or not tracking hears of new alerts once it uploads again.
