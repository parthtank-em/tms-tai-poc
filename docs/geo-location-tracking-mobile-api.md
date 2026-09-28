# Geo Location Tracking — Mobile API Reference

For developers building the mobile app. It covers the four endpoints a device calls: start a session, send a location, upload an offline batch, and stop.

Design background is in [geo-location-tracking-poc-implementation.md](./geo-location-tracking-poc-implementation.md).

---

## 1. Overview

A **session** is one tracking run. Every tap on **Start** creates a new session, and all locations until **Stop** belong to it.

```text
Start ──► POST /api/tracking/sessions                      → sessionId
  │
  ├─ online:  POST /api/tracking/sessions/{sessionId}/locations       (one point, ~every 2 min)
  ├─ offline: keep points in a local queue
  ├─ back online: POST /api/tracking/sessions/{sessionId}/locations/bulk  (the queue)
  │
Stop ──► POST /api/tracking/sessions/{sessionId}/stop
```

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/tracking/sessions` | [Start a session](#31-start-a-session) |
| POST | `/api/tracking/sessions/{sessionId}/locations` | [Send one location](#32-send-one-location) |
| POST | `/api/tracking/sessions/{sessionId}/locations/bulk` | [Upload queued locations](#33-upload-queued-locations-bulk) |
| POST | `/api/tracking/sessions/{sessionId}/stop` | [Stop the session](#34-stop-a-session) |

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
| Location id | String, 1–100 chars, **generated on the device**. Use a UUID v4. | `"0d5c3c3e-8d0f-4b8a-9d8e-2f5e9c1a7b11"` |
| Latitude | JSON **number**, −90 to 90 | `21.1702` |
| Longitude | JSON **number**, −180 to 180 | `72.8311` |
| Timestamp | ISO 8601 string in **UTC** with a `Z` suffix | `"2026-09-28T08:32:00.000Z"` |

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

```json
{ "deviceId": "device-123" }
```

**Response — `201 Created`**

```json
{
  "sessionId": "f61e6baf-e426-46ca-8fff-7243ae3d5cdd",
  "status": "ACTIVE",
  "startedAt": "2026-09-28T09:12:41.272Z"
}
```

Store `sessionId` durably, not only in memory. Every later call needs it, and it must survive the app being killed while tracking.

**Errors**

| Status | When |
|---|---|
| 400 | `deviceId` missing, empty, not a string, or over 200 characters; or the body isn't valid JSON. |

**Example**

```bash
curl -X POST http://localhost:3000/api/tracking/sessions \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"device-123"}'
```

---

### 3.2 Send one location

```http
POST /api/tracking/sessions/{sessionId}/locations
```

Call this for each GPS fix while online (about every 2 minutes).

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
| `capturedAt` | string | yes | When the GPS fix was taken, not when it's sent. ISO 8601 UTC. |

```json
{
  "id": "0d5c3c3e-8d0f-4b8a-9d8e-2f5e9c1a7b11",
  "latitude": 21.1702,
  "longitude": 72.8311,
  "capturedAt": "2026-09-28T08:32:00.000Z"
}
```

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
| `locations` | array | yes | 1–**1,000** items. Each item has the same shape as [one location](#32-send-one-location). |

```json
{
  "locations": [
    {
      "id": "7b6f1f0a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
      "latitude": 21.1702,
      "longitude": 72.8311,
      "capturedAt": "2026-09-28T08:32:00.000Z"
    },
    {
      "id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      "latitude": 21.1710,
      "longitude": 72.8320,
      "capturedAt": "2026-09-28T08:34:00.000Z"
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

### 3.4 Stop a session

```http
POST /api/tracking/sessions/{sessionId}/stop
```

Call this when the user taps **Stop**. No request body.

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
| 5xx, timeout, no network | Server or network problem | **Keep the points queued** and retry with backoff. Retries are safe because location ids make them idempotent. |

---

## 5. Integration guide

### 5.1 Recommended device logic

```text
on Start tap:
    sessionId = POST /sessions { deviceId }
    save sessionId to persistent storage

on each GPS fix:
    point = { id: newUUID(), latitude, longitude, capturedAt: fixTimeUtc }
    append point to persistent queue            // always queue first

on each send opportunity (new fix, connectivity restored, app resumed):
    if offline: do nothing
    if queue has 1 point:  POST /locations      with that point
    if queue has >1 point: POST /locations/bulk with up to 1,000 points
    on 200: remove exactly those point ids from the queue
    on 400: log; move the batch aside so it doesn't block the queue
    on 404: log; clear the queue for this session
    on 5xx / network error: keep the queue, retry with backoff

on Stop tap:
    stop taking GPS fixes
    flush the queue (as above), then POST /stop
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
| Web map refresh (for reference only) | every 5 seconds |

The two are independent. Sending more often than every 2 minutes works, but isn't needed for the POC.

---

## 6. End-to-end smoke test

Run these in order against a running dev server (`npm run dev`). They cover every mobile endpoint, including a retried bulk upload.

```bash
BASE=http://localhost:3000/api/tracking/sessions

# 1. Start
SESSION_ID=$(curl -s -X POST $BASE -H "Content-Type: application/json" \
  -d '{"deviceId":"smoke-test"}' | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')
echo "session: $SESSION_ID"

# 2. One live location
curl -s -X POST $BASE/$SESSION_ID/locations -H "Content-Type: application/json" \
  -d '{"id":"'$SESSION_ID'-1","latitude":21.1702,"longitude":72.8311,"capturedAt":"2026-09-28T08:32:00.000Z"}'
# → {"success":true,"duplicate":false}

# 3. Offline batch, then the same batch again
BATCH='{"locations":[
  {"id":"'$SESSION_ID'-2","latitude":21.1710,"longitude":72.8320,"capturedAt":"2026-09-28T08:34:00.000Z"},
  {"id":"'$SESSION_ID'-3","latitude":21.1720,"longitude":72.8330,"capturedAt":"2026-09-28T08:36:00.000Z"}]}'
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

Then open `http://localhost:3000/tracking` in a signed-in browser to see the session and its route. `http://localhost:3000/tracking/simulator` drives the same endpoints from the browser, including an offline mode, if you want to see the expected behaviour before building it.

---

## 7. POC limitations

These will change before production. Don't build anything that depends on them staying as they are.

- **No authentication.** Anyone who can reach the server can call these endpoints.
- **No rate limiting.**
- **No link to shipments or drivers.** A session knows only its `deviceId`.
- Accuracy, speed, heading and battery fields aren't accepted yet; extra fields in the body are ignored.
