# Radar POC — Mobile App Flow (Quick Guide)

The APIs the mobile app calls, in the order it calls them. For every field and error, see the full reference: [radar-tracking-mobile-api.md](./radar-tracking-mobile-api.md).

Base URL: your server, e.g. `http://<server>:3000`. No login needed in this POC.

---

## Step 0 — App opens (Radar SDK only, no API)

```text
Radar.initialize(publishableKey)
Radar.setUserId(deviceId)      // a fixed id for this phone
Radar.trackOnce()              // registers this phone in Radar
```

## Step 1 — Show trips the driver can start

```http
GET /api/radar-tracking/trips?status=PLANNED
```

- Returns a list of trips, newest first.
- Show for each trip: source and destination address, planned distance and time (`planned.distanceMeters`, `planned.durationMinutes`).
- If an address is `null`, show the latitude/longitude instead.

## Step 2 — Show one trip's details

```http
GET /api/radar-tracking/trips/{tripId}
```

- Returns the same trip object with full details.
- `404` → trip no longer exists (e.g. deleted on the portal); go back to the list.

`200` response (a trip not started yet):

```json
{
  "id": "cmh3k2x9p0001ab12cd34ef56",
  "deviceId": null,
  "status": "PLANNED",
  "tripStatus": null,
  "createdAt": "2026-10-23T08:30:00.000Z",
  "startedAt": null,
  "endedAt": null,
  "start": {
    "address": "Ring Road, Surat, Gujarat",
    "latitude": 21.2049,
    "longitude": 72.8411,
    "radiusMeters": 300
  },
  "destination": {
    "address": "Alkapuri, Vadodara, Gujarat",
    "latitude": 22.3072,
    "longitude": 73.1812,
    "radiusMeters": 500
  },
  "planned": { "distanceMeters": 152340, "durationMinutes": 168 },
  "eta": null,
  "radarUpdatedAt": null,
  "departedAt": null,
  "arrivedAt": null,
  "radarSyncError": null,
  "locationCount": 0,
  "eventCount": 0
}
```

| Field | Meaning |
|---|---|
| `status` | `PLANNED` → `ACTIVE` (after Start) → `COMPLETED` (after Stop). |
| `deviceId` | Phone that started the trip; `null` while `PLANNED`. |
| `tripStatus` | Radar's status (`PENDING`, `STARTED`, `APPROACHING`, `ARRIVED`, `COMPLETED`, `CANCELED`, `EXPIRED`); `null` until Radar has acknowledged the trip. |
| `start` / `destination` | Geofence centre and radius. `address` is `null` if the point was entered as coordinates. |
| `planned` | Planned route distance and time; can be `null` for older trips. |
| `eta` | `{ "minutes": 42, "distanceMeters": 38000 }` from Radar once the trip is active; `null` before that. |
| `departedAt` / `arrivedAt` | When the phone left the start / reached the destination geofence. |
| `radarSyncError` | Last error talking to Radar, otherwise `null`. |
| `locationCount` / `eventCount` | Points received and Radar events received for this trip. |

All times are ISO 8601 UTC strings.

`404` response:

```json
{ "success": false, "error": "Radar trip not found." }
```

## Step 2b — (Optional) Create a trip on the phone

Only if drivers should plan trips themselves. Otherwise trips come from the web portal.

```http
POST /api/radar-tracking/trips
```

```json
{
  "start":       { "address": "…", "latitude": 21.2049, "longitude": 72.8411, "radiusMeters": 300 },
  "destination": { "address": "…", "latitude": 22.3072, "longitude": 73.1812, "radiusMeters": 500 }
}
```

- `201` → trip created as **PLANNED**. Keep its `id` and go to Step 3.

## Step 3 — Driver taps Start

```http
POST /api/radar-tracking/trips/{tripId}/start
```

```json
{ "deviceId": "device-123" }
```

| Response | What to do |
|---|---|
| `200` | Trip is now **ACTIVE** and belongs to this phone; our server has created the geofences and the Radar trip. Save `tripId` permanently, call `Radar.startTracking(...)`, and optionally `Radar.startTrip(...)` with the `radar` block from the response. |
| `409` with your `deviceId` | An earlier Start worked — continue as `200`. |
| `409` with another `deviceId` | Another phone took the trip. Refresh the list. |
| `502` | Radar failed. Nothing changed — let the driver tap Start again. |

## Step 4 — While driving, send each location

For every location the Radar SDK gives:

```http
POST /api/radar-tracking/trips/{tripId}/locations
```

```json
{
  "id": "uuid-made-on-phone",
  "latitude": 21.18,
  "longitude": 72.84,
  "accuracy": 12,
  "capturedAt": "2026-10-23T09:15:00Z"
}
```

- `200` → saved (`duplicate: true` also means success).
- Offline → keep points in a queue on the phone.
- These points only draw the route line on the portal. Radar gets locations directly from its SDK.

## Step 5 — Back online, send the queued points

```http
POST /api/radar-tracking/trips/{tripId}/locations/bulk
```

```json
{ "locations": [ { … }, { … } ] }
```

- Up to 1,000 points per request.
- `200` → remove those points from the queue. Sending the same batch again is safe.

## Step 6 — Driver taps Stop

```text
Radar.stopTracking()
send any queued points (Step 5)
```

```http
POST /api/radar-tracking/trips/{tripId}/stop
```

- `200` → trip is **COMPLETED**; our server closed the Radar trip and deleted the geofences.
- `409` after an earlier stop → treat as success.
- Clear the saved `tripId`.

---

## What the phone does NOT do

- It does not report entering or exiting a geofence — Radar tells our server by webhook.
- It does not calculate ETA or distance — Radar does, and the portal shows it.

## Summary

| Step | When | API |
|---|---|---|
| 1 | Trip list screen | `GET /trips?status=PLANNED` |
| 2 | Trip detail screen | `GET /trips/{id}` |
| 2b | New trip (optional) | `POST /trips` |
| 3 | Start tapped | `POST /trips/{id}/start` |
| 4 | Each location | `POST /trips/{id}/locations` |
| 5 | Back online | `POST /trips/{id}/locations/bulk` |
| 6 | Stop tapped | `POST /trips/{id}/stop` |

All paths start with `/api/radar-tracking`.
