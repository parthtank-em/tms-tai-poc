# TMS/TAI Integration Runbook — FreightID POC

What actually happens in each direction between FreightID and TAI: endpoints, payloads,
and the rows every step writes.

Companion to `FreightID_TAI_Integration_Findings.md`, which is the specification and the
source of the `§` references used throughout the code. This document describes what was
built.

Reflects branch `jumio-integration` at commit `4c58ef3`.

> **Two things to know before reading.** TAI's inbound webhook payload schema is not
> published and we have no sandbox capture, so `payload.ts` reads each field through a
> list of plausible aliases and leaves anything unrecognised null. And TAI webhook
> deliveries are **at-most-once with no retries** — that single fact drives most of the
> inbound design.

---

# 1. Tables involved

| Table | Holds | Key columns |
| --- | --- | --- |
| `shipments` | One row per TAI shipment. | `tai_shipment_id` (unique), `status`, `tai_status_label`, `tai_last_seen_at` |
| `shipment_stops` | Stops as rows, so each can be addressed by its own TAI id. | `tai_shipment_stop_id` (unique), `type`, `sequence` |
| `shipment_events` | Append-only audit trail, both directions. | `type`, `source`, `occurred_at`, `tai_sync_status` |
| `shipment_alerts` | Local mirror of TAI alerts. | `tai_alert_id`, `alert_type`, `resolved` |
| `webhook_events` | Every inbound delivery, stored before it is parsed. | `type`, `raw_payload`, `auth_result`, `processing_status` |
| `shipment_locations` | GPS pings (TAI throttles to one per 15 min). | `latitude`, `longitude`, `recorded_at` |
| `outbound_jobs` | Reliability queue. Nothing reaches TAI except through a row here. | `operation`, `status`, `attempt_count`, `next_attempt_at` |
| `tai_api_calls` | One row per outbound attempt, success or failure. | `endpoint`, `method`, `response_status`, `error` |
| `drivers` | Local-only. **Not synced to TAI** — see §5 of the findings. | `verification_status` |

Key enums: `ShipmentStatus`, `StopType`, `EventSource`, `ShipmentEventType`,
`TaiSyncStatus`, `WebhookType`, `WebhookAuthResult`, `WebhookProcessingStatus`,
`AlertAction`, `OutboundJobStatus`.

---

# 2. Endpoints involved

## 2.1 Inbound — TAI calls us

| Endpoint | Configure in TAI as | Covers |
| --- | --- | --- |
| `POST /api/webhooks/tai/shipment-create` | `ShipmentCreateUrl` | Use case 1 |
| `POST /api/webhooks/tai/shipment-detail-update` | `ShipmentDetailUpdateUrl` | Use case 2 |
| `POST /api/webhooks/tai/shipment-status-update` | `ShipmentStatusUpdateUrl` | Use case 2 |

## 2.2 Outbound — we call TAI

| Endpoint | Used for |
| --- | --- |
| `POST /PublicApi/Shipping/v2/Alerts` | Raise a security alert |
| `POST /PublicApi/Shipping/v2/Alerts/Resolved` | Resolve one |
| `GET /PublicApi/Broker/v2/Alerts` | List configured alert types |
| `PUT /PublicApi/Shipping/v2/Tracking` | Shipment-level tracking update |
| `PUT /PublicApi/Shipping/v2/Tracking/{shipmentStopId}` | Stop-level actuals and POD |
| `POST /PublicApi/Shipping/v2/ShipmentActivityLogs` | Activity log entry |

Base host from `TAI_API_BASE_URL`, defaulting to `https://www.taibeta.net` (beta). The
findings doc names production instead — set it explicitly.

## 2.3 Internal

| Endpoint | Purpose |
| --- | --- |
| `POST /api/jobs/outbound/run` | Drains the outbound queue (up to 25 jobs). Session-guarded. |

---

# 3. What crosses the boundary, and which way

## 3.1 TAI → FreightID (inbound)

| Carries | Arrives via |
| --- | --- |
| Shipment id, status label, type, service level, mileage | Webhook body |
| Reference numbers — PRO, BOL, PO, shipper reference | Webhook body |
| Customer name (read-only; never written back) | Webhook body |
| Load detail — description, quantity, pieces, weight, hazmat, dimensions | Webhook body |
| Carrier detail — name, MC number, SCAC, phone | Webhook body |
| Stops — TAI stop id, type, sequence, address, windows, appointment, actuals | Webhook body |
| Secondary driver name and phone | Webhook body |
| Alert ids, `createdDate`, `shipmentStopId` | `POST /Alerts` response |
| Configured alert-type names | `GET /Broker/v2/Alerts` response |

## 3.2 FreightID → TAI (outbound)

| Field | Carries | Sent on |
| --- | --- | --- |
| `x-api-key` | Our outbound credential — **separate from the inbound webhook secret** | Every call |
| `shipmentId` | TAI's integer shipment id | Alerts, tracking |
| `shipmentAlerts[]` | Alert type names to raise or resolve | `POST /Alerts`, `/Alerts/Resolved` |
| `actualPickupArrivalDateTime` | Stop arrival time | `PUT /Tracking/{stopId}` |
| `actualPickupDepartureDateTime` | Stop departure time | `PUT /Tracking/{stopId}` |
| `pickupAppointmentBegin/EndDateTime` | Appointment window on a pickup-like stop | `PUT /Tracking/{stopId}` |
| `deliveryAppointmentBegin/EndDateTime` | Appointment window on a delivery-like stop | `PUT /Tracking/{stopId}` |
| `proofOfDeliverySignedBy` | POD signature name, max 200 chars | `PUT /Tracking/{stopId}` |
| `shipmentStatus` | Our lifecycle status as TAI's label | `PUT /Tracking` |

**Never sent:** driver identity or assignment. TAI models drivers as shipment reference
numbers rather than an entity, and §5 of the findings is unresolved, so
`DRIVER_ASSIGNED` is recorded with `tai_sync_status = 'HELD'` and no job is enqueued.

---

# 4. Inbound flow — TAI to FreightID

## Step 1 — The delivery arrives

- **Route:** one of the three thin handlers in `src/app/api/webhooks/tai/*/route.ts`
- **Runs:** `receiveTaiWebhook(request, type)` · `src/lib/tai/receive.ts`

TAI does not sign payloads. There is no HMAC, no `X-Webhook-*` header, not even a
`User-Agent` — the `Authorization` header is the entire security boundary.

```text
Basic  →  TAI_WEBHOOK_BASIC_USER + TAI_WEBHOOK_BASIC_PASSWORD
Static →  TAI_WEBHOOK_AUTH_TOKEN, sent verbatim, no parsing
```

Both halves of Basic are always compared, in constant time, so timing reveals nothing
about which was wrong. **If both schemes are configured, Basic wins** — matching TAI's
own precedence. With neither configured the endpoint fails closed and logs loudly.

## Step 2 — Persist before understanding

```sql
INSERT INTO webhook_events (
  type,               -- SHIPMENT_CREATE | SHIPMENT_DETAIL_UPDATE | SHIPMENT_STATUS_UPDATE
  raw_payload,        -- exactly as received; { "_unparsed": "…" } if not JSON
  headers,            -- credential stripped
  remote_ip,
  auth_result,        -- AUTHORIZED | UNAUTHORIZED | MALFORMED
  processing_status,  -- PENDING, or SKIPPED when the body would not parse
  response_status,    -- 200
  error
)
```

Responses:

```text
401  bad credential  — still logged, because a wrong secret is permanent data loss
200  everything else — including a body we cannot parse or one over 2 MB
```

A non-2xx would destroy the event, since TAI never re-sends. The only deliberate
exception is the 401, which the findings doc asks for so a credential mistake is visible
during testing.

```json
{ "received": true, "webhookEventId": "…", "processed": true }
```

## Step 3 — Normalise the payload

- **Runs:** `normalizeShipmentPayload` · `src/lib/tai/payload.ts`, inside `after()`

Each field is read through a list of aliases, because the payload schema is not
published:

```text
taiShipmentId  ← shipmentId | taiShipmentId | id
statusLabel    ← shipmentStatus | status | statusName
stop.type      ← stopType | type | kind
```

Anything unrecognised stays null. The untouched body is always in
`webhook_events.raw_payload`, so nothing is lost and a delivery can be reprocessed once
the real schema is confirmed.

## Step 4 — Map the status

- **Runs:** `mapShipmentStatus` · `src/lib/tai/status.ts`

TAI's webhook `Version` setting changes two labels — v2 sends `Booked` for `Committed`
and `Quoted` for `Quote`. Both vocabularies are accepted unconditionally; the labels do
not collide, so there is nothing to gain by guessing the version.

**An unmapped label throws.** Guessing would write a wrong lifecycle state, and the raw
payload is safe, so failing loudly and reprocessing later is strictly better. This is
also the tripwire that catches a Version-2 vs Version-3 mismatch.

## Step 5 — Upsert the shipment and its stops

- **Runs:** `applyShipmentPayload` · `src/lib/tai/process.ts` — one transaction

```sql
INSERT INTO shipments (…) ON CONFLICT (tai_shipment_id) DO UPDATE …
  -- new row:      status defaults to 'QUOTE' when TAI sent no label
  -- existing row: null fields are dropped, so a status-only webhook
  --               cannot blank carrier columns a create webhook filled
  -- always:       tai_last_seen_at = now()

INSERT INTO shipment_stops (…) ON CONFLICT (tai_shipment_stop_id) DO UPDATE …
  -- no TAI stop id in the payload → matched on (shipment_id, sequence) instead;
  -- such a stop cannot be addressed by PUT /Tracking/{shipmentStopId} yet

INSERT INTO shipment_events (
  type,            -- derived from the webhook type
  source,          -- 'TAI_WEBHOOK'
  tai_sync_status, -- 'NOT_APPLICABLE' — TAI already knows
  webhook_event_id,
  details          -- webhookType, taiShipmentId, taiStatusLabel, mappedStatus, stopsInPayload
)
```

The null-dropping rule is the important one: a status-update webhook that omits carrier
detail must not wipe what a create webhook already stored.

## Step 6 — Settle the delivery

```sql
UPDATE webhook_events
   SET processing_status = 'PROCESSED', processed_at = now(),
       tai_shipment_id, shipment_id, error = NULL
 WHERE id = <webhookEventId>;
```

On failure the row goes to `FAILED` with the message, and `attempt_count` is
incremented. Processing is idempotent — a delivery already `PROCESSED` is left alone.

---

# 5. Outbound flow — FreightID to TAI

Every outbound call goes through the queue. Nothing calls TAI inline.

## Step 7 — The operator acts

- **UI:** `/shipments/[id]` — lifecycle controls and the alerts dialog
- **Server actions:** `lifecycle-actions.ts`, `alert-actions.ts`

| Action | Function | Outbound operation |
| --- | --- | --- |
| Assign driver | `assignDriver` | **none** — `HELD` |
| Verify driver identity | `verifyDriverIdentity` | none |
| Stop arrival | `recordStopArrival` | `STOP_TRACKING_UPDATE` |
| Stop departure | `recordStopDeparture` | `STOP_TRACKING_UPDATE` |
| Capture POD | `capturePod` | `STOP_TRACKING_UPDATE` |
| Update appointment | `updateStopAppointment` | `STOP_TRACKING_UPDATE` |
| Set shipment status | `setShipmentStatus` | `TRACKING_UPDATE` |
| Raise alert | `raiseAlert` | `ALERTS_CREATE` |
| Resolve alert | `resolveAlert` | `ALERTS_RESOLVE` |

## Step 8 — Record locally, then enqueue

- **Runs:** `recordEvent` · `src/lib/tai/lifecycle.ts` — one transaction

```sql
INSERT INTO shipment_events (
  type, source,          -- 'FREIGHTID_INTERNAL'
  occurred_at, details,
  tai_sync_status        -- PENDING | HELD | NOT_APPLICABLE
);

-- only when the event is one TAI accepts:
INSERT INTO outbound_jobs (
  shipment_id, operation, event_id,
  payload,                -- the request body, built at enqueue time
  status,                 -- 'PENDING'
  attempt_count = 0, max_attempts = 8, next_attempt_at = now()
);
```

**Local first.** The operator's action is durable before any network call. A TAI outage
delays the push; it never loses the fact. The job carries `event_id` so a success
settles *that* event, not "some pending event on this shipment" — which would be wrong
the moment two are in flight.

## Step 9 — The worker drains the queue

- **Runs:** `drainOutboundJobs` · `src/lib/tai/outbound-worker.ts`
- **Triggered by:** `after()` on the action that queued it, and `POST /api/jobs/outbound/run`

Claiming is a conditional `updateMany`, which makes it atomic — two concurrent workers
cannot take the same row. A job locked longer than **5 minutes** is presumed dead and
reclaimed.

```text
backoff = min(30s × 2^(attempt-1), 1 hour)
attempts = 8, then DEAD_LETTER
```

`DEAD_LETTER` stops the retry loop without deleting anything — it means a human has to
look.

## Step 10 — The call itself

- **Runs:** `call()` · `src/lib/tai/api-client.ts` · **30 s** timeout

```http
PUT https://www.taibeta.net/PublicApi/Shipping/v2/Tracking/{shipmentStopId}
Accept: application/json
Content-Type: application/json
x-api-key: <TAI_API_KEY>

{
  "actualPickupArrivalDateTime": "2026-09-01T14:05:00Z",
  "proofOfDeliverySignedBy": "J. Smith"
}
```

Despite the field names, `actualPickup*` means *this stop's* arrival and departure
regardless of stop type — the stop is identified by the path parameter, and
`PublicAPIShipmentTrackingUpdateShort` has no delivery-specific pair.

Every attempt is logged, success or failure:

```sql
INSERT INTO tai_api_calls (
  endpoint, method, request_body, response_status, response_body,
  error, attempt, duration_ms, job_id, shipment_id, event_id
)
```

Retry classification:

```text
retryable      408 · 429 · 5xx · network error / timeout
not retryable  every other 4xx · missing credential · invalid shipment id
               · proofOfDeliverySignedBy over 200 chars
```

## Step 11 — Settle the job and the event

```sql
-- success
UPDATE outbound_jobs   SET status = 'SUCCEEDED', completed_at = now(),
                           locked_at = NULL, locked_by = NULL;
UPDATE shipment_events SET tai_sync_status = 'SYNCED', tai_synced_at = now();

-- failure
UPDATE outbound_jobs   SET status = 'PENDING' | 'DEAD_LETTER',
                           attempt_count = attempt_count + 1,
                           next_attempt_at = now() + backoff,
                           last_error, locked_at = NULL, locked_by = NULL;
UPDATE shipment_events SET tai_sync_status = 'FAILED', tai_sync_error = …;
```

For alert jobs the TAI alert id comes back on the response and is written to
`shipment_alerts.tai_alert_id`, which stays null until then — an alert raised during a
TAI outage is still recorded locally.

---

# 6. Sync states

| `tai_sync_status` | Means | Shown as |
| --- | --- | --- |
| `NOT_APPLICABLE` | Inbound event — TAI already knows | — |
| `HELD` | Deliberately kept local (driver assignment, §5) | Local only |
| `PENDING` | Queued, not yet delivered | Sending… |
| `SYNCED` | TAI accepted it | Sent |
| `FAILED` | Attempts exhausted or a permanent error | Failed |

---

# 7. Failure handling summary

| Situation | What happens |
| --- | --- |
| Bad webhook credential | `401` returned and the rejection logged. TAI never re-sends, so the attempt is recorded rather than silently dropped. |
| Webhook body will not parse | Stored as `{"_unparsed": …}`, marked `SKIPPED`, acked `200`. Replayable by hand. |
| Webhook body over 2 MB | Truncation noted, acked `200`, not processed. |
| Unmapped status label | Processing throws; the row goes `FAILED` with the label named. Raw payload retained for reprocessing. |
| Payload has no TAI shipment id | Processing fails — nothing can be matched or created. |
| Stop has no TAI stop id | Upserted by `(shipment_id, sequence)`. Cannot be pushed to `PUT /Tracking/{stopId}` until TAI supplies one. |
| `TAI_API_KEY` unset | Job fails as not retryable. The alert stays recorded locally. |
| TAI 5xx / timeout | Job retried with exponential backoff, up to 8 attempts. |
| Attempts exhausted | `DEAD_LETTER`. Nothing is deleted; a human has to look. |
| Worker dies mid-flight | The lock ages out after 5 minutes and the job is reclaimed. |

---

# 8. Configuration

| Variable | Direction | Used for |
| --- | --- | --- |
| `TAI_WEBHOOK_BASIC_USER` / `_PASSWORD` | Inbound | Basic credential — wins over the static token. Also the admin UI login. |
| `TAI_WEBHOOK_AUTH_TOKEN` | Inbound | Static `Authorization` string, compared verbatim |
| `TAI_API_KEY` | Outbound | `x-api-key` — a **different** secret from the inbound one |
| `TAI_API_BASE_URL` | Outbound | Host only. Defaults to the beta host. |
| `AUTH_SESSION_SECRET` | — | Signs the admin session cookie |
| `DATABASE_URL` / `DIRECT_URL` | — | Neon pooled / unpooled |

See `.env.example` for the full annotated list.

---

# 9. Where the code lives

```text
src/lib/tai/
├── auth.ts             inbound credential check, header scrubbing, client IP
├── receive.ts          shared webhook entry point — persist, ack, then process
├── payload.ts          alias-tolerant normalisation of an unpublished schema
├── status.ts           TAI status labels and stop types → our enums
├── process.ts          upsert shipment + stops + event, settle the delivery
├── lifecycle.ts        use case 3 — operator actions, local first
├── alerts.ts           use case 4 — raise and resolve
├── alert-types.ts      alert-type list from TAI, cached 5 minutes
├── outbound-worker.ts  the queue: claim, call, back off, settle
└── api-client.ts       TAI Public REST API + per-attempt audit log

src/app/api/webhooks/tai/   three thin route handlers
src/app/api/jobs/outbound/  queue runner
src/app/shipments/          list, detail, lifecycle controls, alerts dialog
```

---

# 10. Known gaps

Carried from the findings doc, unresolved in the code:

- **Driver sync (§5).** `DRIVER_ASSIGNED` is `HELD`. It is unconfirmed whether
  `POST /LogShipmentChanges` persists reference numbers or merely logs a diff.
- **Webhook payload schema (§3).** Inferred through aliases. Needs one real capture to
  confirm.
- **Webhook `Version` (§9).** Unknown which is configured, so both label sets are
  accepted.
- **Alert type values (§9).** Undocumented, so `alert_type` is free text validated
  against the list `GET /Broker/v2/Alerts` returns.
- **`shipmentStopId` on alerts (§9).** TAI returns one it does not accept in the
  request; we record whatever comes back.
- **Appointment vs estimate.** `shipment_stops` collapses both into
  `window_start`/`window_end`, so writing an appointment overwrites an estimate that
  arrived by webhook.
- **No reconciliation poll.** `tai_last_seen_at` exists for one, but nothing yet covers
  webhooks that were never delivered.
- **No cron credential.** `POST /api/jobs/outbound/run` is session-guarded; a real
  scheduler needs its own credential rather than a shared secret.
- **No tests.** Unlike the Jumio integration, the TAI side has no unit or integration
  coverage.
