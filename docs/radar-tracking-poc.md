# Radar Geofencing POC — Design

An independent POC that evaluates [Radar](https://radar.com) for trip planning and tracking: address search, route preview, geofence entry/exit, trip status (started → approaching → arrived) and ETA. Trips are **planned on the web portal** and **started by a phone**. Maps are Google Maps; everything drawn on them (route, geofences, events) comes from Radar.

It runs **alongside** the existing geolocation tracking POC (`/tracking`) and shares nothing with it except the console login and the generic UI components — and the Radar project itself: `/tracking` also uses Radar, for its geofences only (no trips). Both POCs use the same keys and the same webhook (`/api/webhooks/radar`); the `/tracking` fences are tagged `tms-track-start` / `tms-track-dest`, and the webhook hands those events to `/tracking` before anything else.

Mobile API reference: [radar-tracking-mobile-api.md](./radar-tracking-mobile-api.md).

---

## 1. What changes compared with `/tracking`

The two POCs now work the same way — portal (or optional phone) planning, Start by one phone creating two Radar fences and a Radar trip, live ETA and trip status by webhook, the same pages and the same mobile API shapes. **The one difference is where the planned route comes from:**

| | `/tracking` | `/radar-tracking` (this POC) |
|---|---|---|
| Planned route, distance, ETA (Preview / Submit / `POST` create) | **Google Routes API** — drive, traffic-aware | **Radar route API** — truck |

Everything else is the same, with each POC under its own names:

| | `/tracking` | `/radar-tracking` |
|---|---|---|
| API paths | `/api/tracking/sessions/…` | `/api/radar-tracking/trips/…` |
| Fence tags | `tms-track-start` / `tms-track-dest` | `tms-radar-start` / `tms-radar-dest` |
| Radar trip `externalId` | `tms-track-{sessionId}` | `{tripId}` |
| Tables | `tracking_sessions`, `tracking_locations`, `tracking_events` | `radar_trips`, `radar_trip_locations`, `radar_events` |

## 2. Isolation

| Layer | Existing (untouched) | Radar POC |
|---|---|---|
| Pages | `/tracking/*` | `/radar-tracking/*` |
| API | `/api/tracking/*` | `/api/radar-tracking/*`, `/api/webhooks/radar` |
| Library | `src/lib/tracking/*` | `src/lib/radar/*` |
| Components | `src/components/tracking/*` | `src/components/radar-tracking/*` |
| Tables | `tracking_sessions`, `tracking_locations`, `tracking_geofence_events` | `radar_trips`, `radar_trip_locations`, `radar_events` |

Shared files are only appended to: `prisma/schema.prisma` (a new section), `src/lib/pocs.ts`, `src/proxy.ts`, `.env.example`, `package.json`.

## 3. Flow

### 3.1 Planning (web portal)

`/radar-tracking` → **Add trip** opens `/radar-tracking/new`: source and destination on the left, the Google map on the right.

```text
Portal (browser)                     Our backend                              Radar
────────────────                     ───────────                              ─────
type in Source / Destination ──────► Google Places (in the browser, not our backend):
   suggestions under the box ◄──────   AutocompleteSuggestion.fetchAutocompleteSuggestions
pick one ──────────────────────────►   place.fetchFields(formattedAddress, location)
   address + lat/lng filled in
   (or enter latitude / longitude when the address is not found)
geofence radius for each end
Preview ───────────────────────────► previewRouteAction ──────────────────►  GET /v1/route/distance
   map: both pins, both circles,  ◄── distance, duration, route line            (mode truck, linestring)
   route; card: distance + ETA
Submit ────────────────────────────► createTripAction: routes again,  ────►  GET /v1/route/distance
                                       saves radar_trips row as PLANNED
                                       (nothing is created in Radar)
```

- **Preview** saves nothing. **Submit** does not rely on it: the server routes the trip again, so a trip is never stored with figures for points other than its own.
- A **PLANNED** trip can be **edited** (`/radar-tracking/{id}/edit`) or **deleted** from its page. Once a phone starts it, neither is possible. The write is conditional on `status = PLANNED`, so an edit cannot race a Start.
- Address search is **Google Places Autocomplete (New)**, called from the browser with the Google Maps key. All the typing for one pick shares a session token, so Google bills it as one session. The Cloud project needs **Places API (New)** enabled.
- Google's terms allow caching a place's coordinates for at most 30 days (only the place ID may be kept), and restrict using Places data with non-Google services — here the coordinates go to Radar for routing and geofences. Fine for this POC; check both before production.
- The phone can plan a trip too: `POST /api/radar-tracking/trips` with the same two ends runs the same `planTrip` (route computed, saved as `PLANNED`, nothing in Radar). It then starts it like any other planned trip.

### 3.2 Tracking (phone)

```text
Phone (Radar SDK)                    Our backend                              Radar
─────────────────                    ───────────                              ─────
Radar.initialize(pk)
Radar.setUserId(deviceId)
Radar.trackOnce()  ───────────────────────────────────────────────────────►  user exists
GET /trips?status=PLANNED ─────────► the trips a driver can start
GET /trips/{id}           ─────────► trip detail
POST /trips/{id}/start {deviceId} ─► claim: PLANNED → ACTIVE, deviceId, startedAt
                                      PUT geofence tms-radar-start/{tripId} ─►  (userIds = deviceId)
                                      PUT geofence tms-radar-dest/{tripId}  ─►  (userIds = deviceId)
                                      POST /v1/trips {externalId: tripId,   ─►  trip started
                                        userId, mode: car, destination fence}
            ◄──────────────────────── { tripId, radar: {...} }
Radar.startTracking(trip preset, replay: all)  ──────────────────────────►  enter/exit, ETA,
on each location: POST /trips/{id}/locations ─► radar_trip_locations          approaching, arrived
                                                                                 │
                                     POST /api/webhooks/radar ◄──────────────────┘
                                      ├─ verify X-Radar-Signature
                                      ├─ radar_events (id = Radar _id, idempotent)
                                      └─ radar_trips: status, ETA, departedAt, arrivedAt
POST /trips/{id}/stop ─────────────► PATCH /v1/trips/{tripId}/update status=completed
                                      DELETE both geofences, status = COMPLETED
Radar.stopTracking()
Web map ◄── polls GET /api/radar-tracking/trips/{id}/feed?after=<cursor>
```

**Radar is only called at Start**, not when the trip is planned: the fences are scoped to one Radar user (`userIds = deviceId`) and the Radar trip names its `userId`, and no phone is known until someone starts the trip. Unscoped fences would fire for every Radar user who drives through.

**Once only, any phone.** The claim is `UPDATE … WHERE status = 'PLANNED'`, so of two phones pressing Start together exactly one wins; the other gets `409`. If a Radar call then fails, the fences are deleted and the trip goes back to `PLANNED` (`502`), so the phone can retry and no half-created trip is left in Radar.

**The server creates the Radar trip**, not the phone. That keeps the trip's id, destination and mode in one place, and the phone only has to track. The phone may still call `Radar.startTrip` with the same `externalId` if the app team wants the SDK's trip-aware tracking options; Radar matches trips on `externalId`.

### 3.3 Trip page

The trip page draws, on a Google map: both fences, the **planned route** (dashed, from planning), the **driven route** (solid, from the phone's locations), and Radar's milestone events where they happened. A planned trip's page polls as well, so it switches to the live view when a phone starts the trip.

## 4. Radar setup (dashboard, once)

1. Use the **Test** environment. Copy the test publishable key (`prj_test_pk_…`) and secret key (`prj_test_sk_…`). The publishable key also serves the routing used by the planner. (Maps and address search are Google.)
2. **Settings → Trip tracking:** set the approaching threshold (minutes before arrival).
3. **Settings → SDK / remote tracking options:** enable offline replay (`replay: all`).
4. **Integrations → Webhooks:** add `https://<tunnel>/api/webhooks/radar`, environment Test, delivery **Multiple Events**. Copy the webhook's security token into `RADAR_WEBHOOK_TOKEN`. Radar cannot reach `localhost`, so use an ngrok or Cloudflare tunnel in development, as with Jumio.

   Enable these event types. The webhook is shared with `/tracking`, which uses the same ones:

   | Event | What it drives (same in both POCs) |
   |---|---|
   | `user.entered_geofence` | "Entered … geofence" on the map. |
   | `user.exited_geofence` | `departedAt` (start fence). |
   | `user.updated_trip` | Trip status and ETA while driving. |
   | `user.approaching_trip_destination` | Status `approaching`, plus ETA. |
   | `user.arrived_at_trip_destination` | Status `arrived` and `arrivedAt`. |
   | `user.stopped_trip` | Final status when Radar closes the trip itself (e.g. expiry). |

   Other event types are not needed. If Radar sends them anyway, the webhook acknowledges and drops the ones that belong to neither POC. `user.started_trip` is not needed because the trip's first status comes from Radar's response to `POST /v1/trips`.

## 5. Data model

**`radar_trips`**: one per trip. `id` is our UUID and also the Radar trip's `externalId` and both geofences' `externalId`. Holds the start/destination fences with the address each was picked from (`null` when entered as coordinates), the planned route (`plannedDistanceMeters`, `plannedDurationMinutes`, and `plannedRoute` — the GeoJSON line's coordinates), our own lifecycle (`PLANNED`/`ACTIVE`/`COMPLETED`; `deviceId` and `startedAt` are `null` while `PLANNED`), Radar's trip status, the latest Radar ETA (`etaMinutes`, `etaDistanceMeters`, `radarUpdatedAt`), and `departedAt` / `arrivedAt` taken from events. `radarSyncError` records the last failed Radar call so the page can show it.

**`radar_trip_locations`**: the route line. Device-generated ids make retries idempotent, exactly as in `/tracking`.

**`radar_events`**: every Radar event that belongs to a trip. Primary key is Radar's `_id`, so a redelivered webhook is skipped. `actualCreatedAt` is when it happened on the device (differs from `createdAt` for replayed offline locations); the raw event is kept in `payload`.

**Newest wins:** a webhook only moves the trip's status/ETA if its `actualCreatedAt` is newer than `radarUpdatedAt`, so a late replayed event cannot overwrite a fresher one.

## 6. Constraints learned from Radar's docs

- Trip modes are `foot`, `bike`, `car` only. This POC tracks trips as **car**, so live ETAs are car ETAs and will be optimistic for trucks.
- The routing API (`/route/distance`) does offer `truck`, so the **planned** route, distance and ETA use truck mode (`ROUTE_MODE` in `src/lib/radar/config.ts`). Where Radar has no truck-specific road data the result matches car (it does for Surat → Vadodara).
- Circle geofence radius is 10–10,000 m. The API accepts 50–10,000 m (below 50 m GPS drift causes false exits).
- Geofences are evaluated for every user unless scoped. Each trip's fences are created with `userIds = deviceId`; the webhook also checks the event's user against the trip's device.
- Webhook signature is `HMAC-SHA1(token, X-Radar-Signing-Id)`. It does **not** cover the body, so it proves Radar knows the token but not that the body is untampered. Acceptable for a POC over HTTPS; noted for production.
- Track requests are limited to 1 per second per device.

## 7. Verification checklist

- [ ] Add trip: typing an address shows suggestions; picking one fills the point; latitude/longitude works for a point the search does not find.
- [ ] Preview draws both pins, both circles and the route, and shows distance and ETA.
- [ ] Submit → row in `radar_trips` with status `PLANNED`, no device, nothing in the Radar dashboard.
- [ ] Edit and Delete work on a planned trip and are gone once it is started.
- [ ] `GET /api/radar-tracking/trips?status=PLANNED` lists it; starting it twice gives `200` then `409`.
- [ ] Start the trip from the simulator → status `ACTIVE`, both geofences visible in the Radar dashboard.
- [ ] Simulator walks out of the start fence → `user.exited_geofence` arrives by webhook, `departedAt` set.
- [ ] ETA updates on the map while the trip runs.
- [ ] Walking into the destination → `approaching` then `arrived`, `arrivedAt` set.
- [ ] Resending a webhook (Radar dashboard → retry) stores nothing twice.
- [ ] Stop → Radar trip completed, both geofences deleted, status `COMPLETED`.
- [ ] `/tracking` still works exactly as before.
