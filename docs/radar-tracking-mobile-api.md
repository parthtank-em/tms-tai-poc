# Radar Geofencing — Mobile Integration Guide

For developers building the mobile app against the **Radar POC** (`/radar-tracking`). This is separate from the geolocation tracking POC described in [geo-location-tracking-mobile-api.md](./geo-location-tracking-mobile-api.md); the two share no endpoints or data.

Design background: [radar-tracking-poc.md](./radar-tracking-poc.md).

---

## 1. Who does what

| Concern | Who |
|---|---|
| Tracking location in the background, battery, offline replay | **Radar SDK** on the phone |
| Deciding when the device enters/leaves the start and destination | **Radar** (server side, from the SDK's locations) |
| Trip status (started → approaching → arrived) and ETA | **Radar** (car mode) |
| Creating the trip and its two geofences in Radar | **Our backend**, on `POST /trips` |
| The route line on our web map | **The app** forwards each SDK location to our backend |
| Completing the trip and removing the fences | **Our backend**, on `POST /trips/{id}/stop` |

The app does **not** report geofence crossings and does **not** compute distance or ETA.

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
Radar.setUserId(deviceId)          // the same deviceId you send to our API
request "Always" location permission (background location on Android)
Radar.trackOnce()                  // creates the Radar user before any trip names it
```

`deviceId` must be stable for the install. It becomes the Radar `userId`; the trip and both geofences are scoped to it, so events only fire for this device.

Native SDK docs: iOS `RadarSDK`, Android `io.radar:sdk`, React Native `react-native-radar`, Flutter `flutter_radar`. Use SDK 3.16 or newer so tracking options (including offline replay) can be controlled from the Radar dashboard.

---

## 4. Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/radar-tracking/trips` | Start a trip |
| POST | `/api/radar-tracking/trips/{tripId}/locations` | Forward one SDK location |
| POST | `/api/radar-tracking/trips/{tripId}/locations/bulk` | Upload queued locations |
| POST | `/api/radar-tracking/trips/{tripId}/stop` | Stop the trip |

### 4.1 Start a trip

```http
POST /api/radar-tracking/trips
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `deviceId` | string | yes | 1–200 chars. Must match `Radar.setUserId`. |
| `start` | object | yes | `latitude` (−90 to 90), `longitude` (−180 to 180), `radiusMeters` (whole number, 50–10,000). |
| `destination` | object | yes | Same fields as `start`. |

```json
{
  "deviceId": "device-123",
  "start":       { "latitude": 21.1702, "longitude": 72.8311, "radiusMeters": 300 },
  "destination": { "latitude": 22.3072, "longitude": 73.1812, "radiusMeters": 500 }
}
```

**Response — `201 Created`**

```json
{
  "tripId": "f61e6baf-e426-46ca-8fff-7243ae3d5cdd",
  "status": "ACTIVE",
  "tripStatus": "STARTED",
  "startedAt": "2026-10-21T09:12:41.272Z",
  "start":       { "latitude": 21.1702, "longitude": 72.8311, "radiusMeters": 300 },
  "destination": { "latitude": 22.3072, "longitude": 73.1812, "radiusMeters": 500 },
  "radar": {
    "userId": "device-123",
    "externalId": "f61e6baf-e426-46ca-8fff-7243ae3d5cdd",
    "mode": "car",
    "startGeofenceTag": "tms-radar-start",
    "destinationGeofenceTag": "tms-radar-dest",
    "destinationGeofenceExternalId": "f61e6baf-e426-46ca-8fff-7243ae3d5cdd"
  }
}
```

By the time this returns, Radar already has both geofences and an active trip for this user. Store `tripId` durably. Then start tracking:

```text
Radar.startTracking(<trip / continuous preset>)
```

Optionally, to get the SDK's trip-aware behaviour, call `Radar.startTrip` with the values from `radar` (`externalId`, `destinationGeofenceTag`, `destinationGeofenceExternalId`, `mode`). Radar matches trips on `externalId`, so this attaches to the trip the server created rather than making a second one.

| Status | When |
|---|---|
| 400 | Invalid body; the `error` names the field. |
| 502 | A Radar call failed. Nothing was created. Safe to retry. |
| 503 | Radar keys are not configured on the server. |

### 4.2 Forward one location

```http
POST /api/radar-tracking/trips/{tripId}/locations
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

A **stopped trip still accepts locations**, so points queued while offline can be uploaded after Stop.

### 4.3 Upload queued locations

```http
POST /api/radar-tracking/trips/{tripId}/locations/bulk
```

`{ "locations": [ … ] }`, 1–1,000 items of the shape above. Idempotent on `id`. Response: `{ "success": true, "inserted": 2, "skipped": 0 }` (`skipped` counts ids already stored).

| Status | When |
|---|---|
| 400 | Empty array, more than 1,000 items, or any invalid item. Validation is all-or-nothing: one bad point rejects the whole batch and nothing is stored. The `error` names the index, e.g. `locations[3].capturedAt …`. |
| 404 | No such trip. Drop the queued points for it. |

As with a single location, a stopped trip still accepts the batch.

This queue is **only for our route line**. Radar receives the offline stretch through the SDK's own replay, independently.

### 4.4 Stop the trip

```http
POST /api/radar-tracking/trips/{tripId}/stop
```

No body. Completes the Radar trip and deletes both geofences.

```json
{
  "success": true,
  "tripId": "f61e6baf-e426-46ca-8fff-7243ae3d5cdd",
  "status": "COMPLETED",
  "tripStatus": "COMPLETED",
  "endedAt": "2026-10-21T10:30:00.000Z",
  "radarSyncError": null
}
```

A Radar failure does not fail the stop; it is reported in `radarSyncError`.

| Status | When |
|---|---|
| 409 | The trip was already stopped. The body has `success: false` plus the same fields as above; treat it as success. |
| 404 | No such trip. |

---

## 5. Recommended device logic

```text
on app launch:
    Radar.initialize(pk); Radar.setUserId(deviceId); Radar.trackOnce()

on Start tap:
    { tripId, radar } = POST /trips { deviceId, start, destination }
    save tripId to persistent storage
    Radar.startTracking(trip preset)                 // replay is set from the dashboard

on each Radar SDK location (listener):
    point = { id: newUUID(), latitude, longitude, accuracy, capturedAt: location.timestamp }
    append point to persistent queue
    if online: POST /locations (1 point) or /locations/bulk (up to 1,000)
               on 200 remove those ids; on 5xx/network keep and retry with backoff
               on 400 move the batch aside; on 404 clear the queue for this trip

on Stop tap (or when you decide the trip is over):
    Radar.stopTracking()
    flush the queue, then POST /stop      // 200 or 409 → clear tripId
```

Radar's own events (`entered_geofence`, `approaching_trip_destination`, `arrived_at_trip_destination`, …) also reach the app through the SDK's event listener if you want to show them on the phone. The server receives them by webhook regardless.

---

## 6. POC limitations

- No authentication or rate limiting on these endpoints.
- ETA is Radar's **car** ETA; Radar trips do not support a truck mode.
- The trip is not linked to a shipment or driver — only to `deviceId`.
- One start and one destination per trip, fixed at Start.
