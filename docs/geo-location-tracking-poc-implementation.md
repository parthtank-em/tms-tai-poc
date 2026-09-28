# Geo Location Tracking POC — Implementation Plan

## 1. POC Goal

Build a minimal location-tracking POC with:

- A mobile app that starts a tracking session.
- A new session created every time **Start** is clicked.
- Mobile sends latitude/longitude to the Next.js backend periodically.
- Mobile can send locations individually while online.
- Mobile can send multiple stored locations in bulk after coming back online.
- A Next.js web application that lists all tracking sessions.
- Completed/ended sessions can be opened and displayed on a map.
- Active sessions are displayed on a map and updated using polling.
- Prisma + PostgreSQL are used for persistence.

> **Out of scope for this POC:** geofencing, route optimization, WebSockets, push notifications, authentication/authorization, and advanced route compression.

---

## 2. High-Level Flow

```text
                    MOBILE APP
                        |
                        | Start
                        v
              POST /tracking/sessions
                        |
                        v
              Tracking Session Created
                        |
             +----------+----------+
             |                     |
          Online                 Offline
             |                     |
             v                     v
       Send location         Store locations
       every ~2 minutes      locally on device
             |                     |
             |                     | Connection restored
             |                     v
             |             POST /locations/bulk
             |                     |
             +----------+----------+
                        |
                        v
                  NEXT.JS API
                        |
                        v
                   PostgreSQL
                        |
                        v
                  NEXT.JS WEB
                        |
             +----------+----------+
             |                     |
          Completed              Active
             |                     |
       Fetch locations          Poll API
          once              every few seconds
             |                     |
             +----------+----------+
                        |
                        v
                      MAP
```

---

# 3. Database Design

For the POC, use only **two tables**.

## 3.1 `tracking_sessions`

Stores one record for every time the driver starts tracking.

### Fields

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Unique session ID |
| `deviceId` | String | Device identifier |
| `startedAt` | DateTime | When tracking started |
| `endedAt` | DateTime? | When tracking stopped |
| `status` | Enum | `ACTIVE` or `COMPLETED` |
| `createdAt` | DateTime | Record creation time |
| `updatedAt` | DateTime | Last update time |

## 3.2 `tracking_locations`

Stores every location received from the mobile app.

### Fields

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Client-generated unique location ID |
| `sessionId` | UUID | Associated tracking session |
| `latitude` | Decimal | Latitude |
| `longitude` | Decimal | Longitude |
| `capturedAt` | DateTime | Time location was captured on mobile |
| `receivedAt` | DateTime | Time backend received the location |

### Why `capturedAt` and `receivedAt` are separate

For offline tracking, a location might be captured at:

```text
10:00 AM
```

but uploaded at:

```text
10:25 AM
```

Therefore:

- `capturedAt` = actual GPS capture time.
- `receivedAt` = server receive time.

The map/route should use `capturedAt` for chronological ordering.

---

# 4. Prisma Schema

Add the following models:

```prisma
enum TrackingSessionStatus {
  ACTIVE
  COMPLETED
}

model TrackingSession {
  id         String               @id @default(uuid())
  deviceId   String
  startedAt  DateTime             @default(now())
  endedAt    DateTime?
  status     TrackingSessionStatus @default(ACTIVE)
  createdAt  DateTime             @default(now())
  updatedAt  DateTime             @updatedAt

  locations TrackingLocation[]

  @@index([deviceId, startedAt])
  @@index([status])
}

model TrackingLocation {
  id         String          @id
  sessionId  String
  latitude   Decimal         @db.Decimal(10, 7)
  longitude  Decimal         @db.Decimal(10, 7)
  capturedAt DateTime
  receivedAt DateTime        @default(now())

  session TrackingSession @relation(
    fields: [sessionId],
    references: [id],
    onDelete: Cascade
  )

  @@index([sessionId, capturedAt])
}
```

## Important

The mobile app generates the `TrackingLocation.id`.

Example:

```text
location ID = UUID generated on mobile
```

This allows the mobile app to retry an offline batch without creating duplicate location records.

---

# 5. API Design

The POC needs six main APIs.

## Mobile APIs

### 5.1 Start Tracking Session

```http
POST /api/tracking/sessions
```

### Request

```json
{
  "deviceId": "device-123"
}
```

### Response

```json
{
  "sessionId": "session-uuid",
  "status": "ACTIVE",
  "startedAt": "2026-09-28T08:30:00.000Z"
}
```

Every time **Start** is clicked, create a new session.

---

## 5.2 Send Single Location

```http
POST /api/tracking/sessions/:sessionId/locations
```

### Request

```json
{
  "id": "location-uuid",
  "latitude": 21.1702,
  "longitude": 72.8311,
  "capturedAt": "2026-09-28T08:32:00.000Z"
}
```

### Response

```json
{
  "success": true
}
```

The mobile app calls this approximately every **2 minutes** while online.

---

## 5.3 Send Offline Locations in Bulk

```http
POST /api/tracking/sessions/:sessionId/locations/bulk
```

### Request

```json
{
  "locations": [
    {
      "id": "location-1",
      "latitude": 21.1702,
      "longitude": 72.8311,
      "capturedAt": "2026-09-28T08:32:00.000Z"
    },
    {
      "id": "location-2",
      "latitude": 21.1710,
      "longitude": 72.8320,
      "capturedAt": "2026-09-28T08:34:00.000Z"
    }
  ]
}
```

### Response

```json
{
  "success": true,
  "inserted": 2
}
```

Use the location ID to make retries idempotent.

---

## 5.4 Stop Tracking Session

```http
POST /api/tracking/sessions/:sessionId/stop
```

### Response

```json
{
  "success": true,
  "sessionId": "session-uuid",
  "status": "COMPLETED",
  "endedAt": "2026-09-28T10:30:00.000Z"
}
```

The backend should:

1. Verify the session exists.
2. Verify it is currently `ACTIVE`.
3. Set `status = COMPLETED`.
4. Set `endedAt`.

---

# 6. Web APIs

## 6.1 Get All Sessions

```http
GET /api/tracking/sessions
```

### Response

```json
[
  {
    "id": "session-1",
    "deviceId": "device-123",
    "startedAt": "2026-09-28T08:30:00.000Z",
    "endedAt": "2026-09-28T10:30:00.000Z",
    "status": "COMPLETED"
  },
  {
    "id": "session-2",
    "deviceId": "device-123",
    "startedAt": "2026-09-28T11:00:00.000Z",
    "endedAt": null,
    "status": "ACTIVE"
  }
]
```

The Next.js UI displays these sessions in a list.

Example:

```text
Tracking Sessions

--------------------------------------------------
Session       Device       Started       Status
--------------------------------------------------
Session 1     device-123   08:30         COMPLETED
Session 2     device-123   11:00         ACTIVE
--------------------------------------------------
```

---

# 7. Get Session Locations

```http
GET /api/tracking/sessions/:sessionId/locations
```

For a completed session, this API can return all locations.

### Response

```json
{
  "sessionId": "session-1",
  "status": "COMPLETED",
  "locations": [
    {
      "id": "location-1",
      "latitude": 21.1702,
      "longitude": 72.8311,
      "capturedAt": "2026-09-28T08:32:00.000Z"
    },
    {
      "id": "location-2",
      "latitude": 21.1710,
      "longitude": 72.8320,
      "capturedAt": "2026-09-28T08:34:00.000Z"
    }
  ]
}
```

Sort locations by:

```text
capturedAt ASC
```

---

# 8. Polling for Active Sessions

Do not repeatedly download the complete location history.

Instead, request only locations received after the last known location.

Example:

```http
GET /api/tracking/sessions/session-1/locations?after=2026-09-28T08:34:00.000Z
```

Backend query concept:

```sql
SELECT *
FROM tracking_locations
WHERE session_id = ?
  AND captured_at > ?
ORDER BY captured_at ASC;
```

Example response:

```json
{
  "locations": [
    {
      "id": "location-3",
      "latitude": 21.1720,
      "longitude": 72.8330,
      "capturedAt": "2026-09-28T08:36:00.000Z"
    }
  ],
  "latestCapturedAt": "2026-09-28T08:36:00.000Z"
}
```

The web application then uses:

```text
latestCapturedAt
```

for the next polling request.

---

# 9. Next.js Map Behavior

## Completed Session

When the user selects a completed session:

```text
1. Get session information
2. Get all locations
3. Display locations on map
4. Draw a line through the locations
5. Optionally show start/end markers
```

No continuous polling is required.

```text
Completed Session
       |
       v
GET all locations
       |
       v
     Map
       |
       v
   Route Line
```

---

## Active Session

When the user selects an active session:

```text
1. Get existing locations.
2. Display them on map.
3. Start polling.
4. Fetch only new locations.
5. Add new locations to the map.
6. Move the current-location marker.
7. Continue polling.
```

Example:

```text
Initial:

A ---- B ---- C
              ^
           Current


After new location:

A ---- B ---- C ---- D
                   ^
                Current
```

---

# 10. Polling Example

A simple React implementation:

```tsx
useEffect(() => {
  if (session.status !== "ACTIVE") {
    return;
  }

  const interval = setInterval(async () => {
    await fetchNewLocations();
  }, 5000);

  return () => clearInterval(interval);
}, [session.status]);
```

For the POC:

```text
Polling interval = 5 seconds
```

This is only for web-map refreshing.

It is independent from mobile GPS frequency:

```text
Mobile GPS:
~ every 2 minutes

Web polling:
~ every 5 seconds
```

---

# 11. Mobile Online/Offline Logic

The mobile application maintains a local queue of locations.

## Online

```text
GPS location
     |
     v
POST single location
     |
     v
Backend
```

## Offline

```text
GPS location
     |
     v
Local storage
     |
     v
Connection restored
     |
     v
POST bulk locations
     |
     v
Backend
```

The POC does not need to decide how the mobile app stores the offline queue. The important backend requirement is that the bulk API accepts multiple locations.

---

# 12. Idempotency

Offline requests can be retried.

Example:

```text
Mobile sends:

location-1
location-2
location-3
```

Network fails after the server receives them.

Mobile retries the same batch.

Without idempotency:

```text
location-1
location-2
location-3
location-1  <-- duplicate
location-2  <-- duplicate
location-3  <-- duplicate
```

With client-generated IDs:

```text
location-1 -> already exists -> skip
location-2 -> already exists -> skip
location-3 -> already exists -> skip
```

For PostgreSQL + Prisma, the bulk operation can use:

```ts
prisma.trackingLocation.createMany({
  data: locations,
  skipDuplicates: true,
});
```

---

# 13. Suggested Next.js Project Structure

For an App Router project:

```text
app/
├── api/
│   └── tracking/
│       └── sessions/
│           ├── route.ts
│           └── [sessionId]/
│               ├── route.ts
│               ├── stop/
│               │   └── route.ts
│               └── locations/
│                   ├── route.ts
│                   └── bulk/
│                       └── route.ts
│
├── tracking/
│   ├── page.tsx
│   └── [sessionId]/
│       └── page.tsx
│
lib/
├── prisma.ts
└── tracking/
    └── tracking.service.ts
```

Recommended separation:

```text
Route Handler
     |
     v
Tracking Service
     |
     v
Prisma
     |
     v
PostgreSQL
```

Keep database logic out of the route handlers where practical.

---

# 14. Implementation Order

Implement the POC in the following order.

## Step 1 — Prisma Setup

- Configure PostgreSQL.
- Add `TrackingSession`.
- Add `TrackingLocation`.
- Run migration.
- Verify tables.

## Step 2 — Start Session API

Implement:

```http
POST /api/tracking/sessions
```

Test with Postman/Thunder Client.

## Step 3 — Single Location API

Implement:

```http
POST /api/tracking/sessions/:sessionId/locations
```

Send test coordinates manually.

Verify records in PostgreSQL.

## Step 4 — Bulk Location API

Implement:

```http
POST /api/tracking/sessions/:sessionId/locations/bulk
```

Test with 10–20 locations.

Test sending the same batch twice and verify that duplicates are not created.

## Step 5 — Stop Session API

Implement:

```http
POST /api/tracking/sessions/:sessionId/stop
```

Verify:

```text
ACTIVE -> COMPLETED
```

## Step 6 — Session List

Implement:

```http
GET /api/tracking/sessions
```

Create a simple Next.js page showing all sessions.

## Step 7 — Session Locations API

Implement:

```http
GET /api/tracking/sessions/:sessionId/locations
```

Return locations ordered by `capturedAt`.

## Step 8 — Map for Completed Sessions

When a completed session is selected:

```text
GET locations
      |
      v
Plot points
      |
      v
Draw route line
```

## Step 9 — Active Session Polling

Add:

```text
GET locations?after=<lastCapturedAt>
```

Poll every 5 seconds.

Update:

```text
route line
current marker
last captured timestamp
```

## Step 10 — Mobile Simulation

Before connecting the real mobile application, create a small script/page that simulates:

```text
Start session
    ↓
Send location
    ↓
Wait 2 minutes
    ↓
Send location
    ↓
...
    ↓
Stop session
```

Also simulate offline mode by sending a bulk request containing old `capturedAt` values.

---

# 15. API Summary

| Method | Endpoint | Used By | Purpose |
|---|---|---|---|
| POST | `/api/tracking/sessions` | Mobile | Start session |
| POST | `/api/tracking/sessions/:sessionId/locations` | Mobile | Send one location |
| POST | `/api/tracking/sessions/:sessionId/locations/bulk` | Mobile | Upload offline locations |
| POST | `/api/tracking/sessions/:sessionId/stop` | Mobile | End session |
| GET | `/api/tracking/sessions` | Web | List sessions |
| GET | `/api/tracking/sessions/:sessionId/locations` | Web | Get locations / polling |

---

# 16. POC Acceptance Criteria

The POC is complete when all of the following work:

### Session

- [ ] Clicking Start creates a new session.
- [ ] Multiple Start actions create separate sessions.
- [ ] Session starts as `ACTIVE`.
- [ ] Stop changes session to `COMPLETED`.
- [ ] `endedAt` is stored.

### Location

- [ ] Mobile can send one location.
- [ ] Location is linked to the correct session.
- [ ] `capturedAt` is stored.
- [ ] `receivedAt` is stored.
- [ ] Multiple locations can be stored.

### Offline

- [ ] Bulk API accepts multiple locations.
- [ ] Offline locations retain their original `capturedAt`.
- [ ] Retrying the same batch does not create duplicates.

### Web

- [ ] All sessions are displayed.
- [ ] Completed session can be selected.
- [ ] Completed session locations are displayed on the map.
- [ ] Active session can be selected.
- [ ] Active session starts polling.
- [ ] New locations appear without refreshing the page.
- [ ] Current location marker moves as new coordinates arrive.

---

# 17. Deliberately Excluded From This POC

Do **not** implement these yet:

- Geofencing.
- PostGIS.
- Route optimization.
- WebSockets.
- Server-Sent Events.
- Push notifications.
- Advanced background-location implementation.
- Battery optimization.
- Location accuracy optimization.
- Route compression.
- Douglas-Peucker simplification.
- Shipment integration.
- Driver assignment.
- Authentication/authorization.

These can be added after the basic location pipeline is proven.

---

# 18. Future Architecture

Once this POC works, the next phase can introduce:

```text
Mobile GPS
    |
    v
Local Offline Queue
    |
    v
Location API
    |
    v
Tracking Sessions
    |
    v
Location Storage
    |
    +--------------------+
    |                    |
    v                    v
Live Tracking       Route History
    |                    |
    v                    v
Polling/WebSocket    Route Optimization
    |
    v
Geofencing
```

The important goal of this POC is to first prove:

```text
Mobile
  -> Send coordinates
  -> Store coordinates
  -> Handle offline bulk upload
  -> Display coordinates
  -> Display historical route
  -> Display active session using polling
```

Once this works reliably, additional tracking and geofencing features can be built on top of it.
