# Radar Geofencing POC — Design

An independent POC that evaluates [Radar](https://radar.com) for trip tracking: geofence entry/exit, trip status (started → approaching → arrived) and ETA. It runs **alongside** the existing geolocation tracking POC (`/tracking`) and shares nothing with it except the console login, the Google Maps key used to draw the map, and the generic UI components — and the Radar project itself: `/tracking` also uses Radar, for its geofences only (no trips). Both POCs use the same keys and the same webhook (`/api/webhooks/radar`); the `/tracking` fences are tagged `tms-track-start` / `tms-track-dest`, and the webhook hands those events to `/tracking` before anything else.

Mobile API reference: [radar-tracking-mobile-api.md](./radar-tracking-mobile-api.md).

---

## 1. What changes compared with `/tracking`

| | `/tracking` (existing) | `/radar-tracking` (this POC) |
|---|---|---|
| Who decides inside/outside a fence | Radar, from the locations its SDK tracks (fences tagged `tms-track-*`, crossings by webhook) | Radar, from the locations its SDK tracks (fences tagged `tms-radar-*`, crossings by webhook) |
| ETA / remaining distance | Computed on the phone (Google Routes API), sent with each location | Radar trip ETA (car mode), delivered by webhook |
| Trip status | Inferred from events by a person reading the map | Radar trip status: started, approaching, arrived, completed… |
| Offline | Radar SDK replays offline locations to Radar, so crossings arrive late by webhook; our own queue only for locations | Radar SDK replays offline locations to Radar (`replay: all`); our own queue only for the route line |
| Route line on the map | Every location the phone posts | The same — the phone forwards each Radar SDK location to us (Radar has no per-location webhook) |

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

```text
Phone (Radar SDK)                    Our backend                              Radar
─────────────────                    ───────────                              ─────
Radar.initialize(pk)
Radar.setUserId(deviceId)
Radar.trackOnce()  ───────────────────────────────────────────────────────►  user exists
POST /api/radar-tracking/trips ────► insert radar_trips row
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

**The server creates the Radar trip**, not the phone. That keeps the trip's id, destination and mode in one place, and the phone only has to track. The phone may still call `Radar.startTrip` with the same `externalId` if the app team wants the SDK's trip-aware tracking options; Radar matches trips on `externalId`.

## 4. Radar setup (dashboard, once)

1. Use the **Test** environment. Copy the test publishable key (`prj_test_pk_…`) and secret key (`prj_test_sk_…`).
2. **Settings → Trip tracking:** set the approaching threshold (minutes before arrival).
3. **Settings → SDK / remote tracking options:** enable offline replay (`replay: all`).
4. **Integrations → Webhooks:** add `https://<tunnel>/api/webhooks/radar`, environment Test, delivery **Multiple Events**. Copy the webhook's security token into `RADAR_WEBHOOK_TOKEN`. Radar cannot reach `localhost`, so use an ngrok or Cloudflare tunnel in development, as with Jumio.

   Enable these event types. The webhook is shared with `/tracking`, so the list covers both POCs:

   | Event | Used by | What it drives |
   |---|---|---|
   | `user.entered_geofence` | Both | `/tracking`: ENTER crossing. `/radar-tracking`: "Entered … geofence" on the map. |
   | `user.exited_geofence` | Both | `/tracking`: EXIT crossing. `/radar-tracking`: `departedAt` (start fence). |
   | `user.updated_trip` | `/radar-tracking` | Trip status and ETA while driving. |
   | `user.approaching_trip_destination` | `/radar-tracking` | Status `approaching`, plus ETA. |
   | `user.arrived_at_trip_destination` | `/radar-tracking` | Status `arrived` and `arrivedAt`. |
   | `user.stopped_trip` | `/radar-tracking` | Final status when Radar closes the trip itself (e.g. expiry). |

   Other event types are not needed. If Radar sends them anyway, the webhook acknowledges and drops the ones that belong to neither POC. `user.started_trip` is not needed because the trip's first status comes from Radar's response to `POST /v1/trips`.

## 5. Data model

**`radar_trips`**: one per trip. `id` is our UUID and also the Radar trip's `externalId` and both geofences' `externalId`. Holds the start/destination fences, our own lifecycle (`ACTIVE`/`COMPLETED`), Radar's trip status, the latest Radar ETA (`etaMinutes`, `etaDistanceMeters`, `radarUpdatedAt`), and `departedAt` / `arrivedAt` taken from events. `radarSyncError` records the last failed Radar call so the page can show it.

**`radar_trip_locations`**: the route line. Device-generated ids make retries idempotent, exactly as in `/tracking`.

**`radar_events`**: every Radar event that belongs to a trip. Primary key is Radar's `_id`, so a redelivered webhook is skipped. `actualCreatedAt` is when it happened on the device (differs from `createdAt` for replayed offline locations); the raw event is kept in `payload`.

**Newest wins:** a webhook only moves the trip's status/ETA if its `actualCreatedAt` is newer than `radarUpdatedAt`, so a late replayed event cannot overwrite a fresher one.

## 6. Constraints learned from Radar's docs

- Trip modes are `foot`, `bike`, `car` only. This POC uses **car**, so ETAs are car ETAs and will be optimistic for trucks.
- Circle geofence radius is 10–10,000 m. The API accepts 50–10,000 m (below 50 m GPS drift causes false exits).
- Geofences are evaluated for every user unless scoped. Each trip's fences are created with `userIds = deviceId`; the webhook also checks the event's user against the trip's device.
- Webhook signature is `HMAC-SHA1(token, X-Radar-Signing-Id)`. It does **not** cover the body, so it proves Radar knows the token but not that the body is untampered. Acceptable for a POC over HTTPS; noted for production.
- Track requests are limited to 1 per second per device.

## 7. Verification checklist

- [ ] Start a trip from the simulator → row in `radar_trips`, both geofences visible in the Radar dashboard.
- [ ] Simulator walks out of the start fence → `user.exited_geofence` arrives by webhook, `departedAt` set.
- [ ] ETA updates on the map while the trip runs.
- [ ] Walking into the destination → `approaching` then `arrived`, `arrivedAt` set.
- [ ] Resending a webhook (Radar dashboard → retry) stores nothing twice.
- [ ] Stop → Radar trip completed, both geofences deleted, status `COMPLETED`.
- [ ] `/tracking` still works exactly as before.
