# FreightID ↔ TAI TMS Integration — Findings & Implementation Plan

> Compiled from a series of research/planning conversations. Intended as a reference doc for implementation (e.g., handing to Claude Code to scaffold the actual application).

---

## 1. Context

**FreightID** is the application being built locally. It integrates with **TAI (BrokerTMS)**, a third-party Transportation Management System, to synchronize shipment data, driver/shipment lifecycle events, and security alerts.

The integration has two distinct data paths:

1. **Inbound (TAI → FreightID):** TAI's **webhook system** pushes shipment/customer/carrier/accounting events to FreightID.
2. **Outbound (FreightID → TAI):** FreightID calls TAI's **Public REST API** (`https://www.taicloud.net/PublicApi/...`) to write status updates, activity logs, and alerts back into TAI.

These are two separate mechanisms with **different auth schemes** — do not confuse them.

---

## 2. Original 4 Use Cases (from internal "3rd Party Integrations" doc)

| # | Use Case | Direction |
|---|----------|-----------|
| 1 | Shipment Created in TMS | TAI → FreightID |
| 2 | Shipment Details Updated | TAI → FreightID |
| 3 | Shipment Updated in FreightID (internal lifecycle: driver assigned, verified, arrived, picked up, in transit, delivered, POD captured) | FreightID-internal, partially synced back to TAI |
| 4 | Security Alert / Exception | FreightID → TAI |

---

## 3. Inbound: TAI Webhook System

**How it works:** Configured via `IntegrationSource` of type `PublicAPIWebhooks` in TAI admin, scoped to Linked Organizations. TAI POSTs JSON to your configured URLs when events occur.

### Relevant webhooks for use cases 1 & 2

| Webhook | Trigger | Maps to |
|---|---|---|
| `ShipmentCreateUrl` | New shipment persisted | Use case 1 |
| `ShipmentDetailUpdateUrl` | Any shipment field/child record edited | Use case 2 |
| `ShipmentStatusUpdateUrl` | Status change, stop-date edit, EDI 214, tracking updates | Use case 2 |
| `ShipmentLocationUpdateUrl` | GPS/location ping (15-min throttle) | Optional, for live location |

### Key behaviors (critical for implementation)

- **HTTP method:** POST, `application/json`, UTF-8, camelCase properties, ISO 8601 UTC dates.
- **No automatic retries. At-most-once delivery.** If FreightID is down or errors, the event is logged by TAI and never resent. **Endpoint availability is entirely on FreightID.**
- **Shipment webhooks batch ~1 minute** after the triggering event — rapid edits within that window coalesce into a single delivery (timer resets on each new change). Do not expect instant delivery.
- **Accounting/customer/carrier webhooks fire immediately** (except `BillCreateUrl`, ~5s delay).
- **`Version` setting (2 or 3)** controls status label format:
  - v2: `Committed → Booked`, `Quote → Quoted` (others unchanged)
  - v3 (default): statuses as-is (`Committed`, `Quote`)
  - **Must confirm which version is configured for this integration** before writing status-parsing logic.
- **Transport:** HTTPS strongly recommended but not enforced by TAI. TAI supports **TLS 1.0/1.1/1.2 only — not TLS 1.3**. Do not configure endpoint as TLS-1.3-only or delivery will fail silently.
- **No signature/HMAC.** Only header-based auth (see below). No `X-Webhook-*` or `User-Agent` headers either.
- **3xx responses are followed** automatically by TAI.
- **Respond fast:** TAI's HttpClient timeout is ~100 seconds, but best practice is to return `200 OK` immediately and process asynchronously in a background queue.

### Authentication (inbound webhooks)

Two options, configured as TAI Source Setting parameters:

1. **Static `Authorization` header** — any string, sent verbatim (e.g., `Bearer <token>`, `ApiKey <key>`).
2. **HTTP Basic Auth** — `UserName` + `Password` → base64-encoded `Authorization: Basic ...`.
3. **If both configured, Basic wins.**

**Recommended verification approach (since TAI doesn't sign payloads):**
- Treat the `Authorization` value as a long, random shared secret.
- Accept HTTPS only.
- Return `401 Unauthorized` for missing/incorrect credentials (TAI logs this, does not retry — get it right during testing).

### Error handling / logging (TAI-side, for reference only — not visible to us)

- Single delivery attempt, no retry, ever — regardless of response code (2xx and 5xx are logged identically, no re-delivery either way).
- TAI logs to `WebhookActivityLogs` (their side): url, status code, request/response body, error message, timing. ~10s flush delay before queryable in their system.
- **Implication for FreightID:** Since we cannot see TAI's logs, **FreightID must maintain its own inbound webhook log** (raw payload, timestamp, auth result, processing outcome) and ideally a periodic reconciliation/poll against TAI's read APIs, since a missed webhook has no automatic recovery path.

---

## 4. Outbound: TAI Public REST API

Base URL: `https://www.taicloud.net/PublicApi/Shipping/v2/...`
**Auth:** `x-api-key` header (API Key Authentication) — **different from the webhook `Authorization` header/Basic auth.** Two separate credentials to manage.

### 4.1 Use Case 4 — Security Alerts

**Create alert:**
```
POST /PublicApi/Shipping/v2/Alerts
Body: { "shipmentId": int, "shipmentAlerts": ["<AlertTypeString>", ...] }
Response: array of { type, alertId, createdDate, resolved, shipmentStopId }
```

**Resolve alert:**
```
POST /PublicApi/Shipping/v2/Alerts/Resolved
Body: { "shipmentId": int, "shipmentAlerts": ["<AlertTypeString>", ...] }
Response: same shape as above
```

**Open question for TAI/client:** The exact valid `shipmentAlerts` string values (enum) are not documented — need TAI to provide the accepted alert-type list so FreightID's internal alert types can map correctly. Also unclear how `shipmentStopId` (returned but not accepted in the request) gets associated — does TAI auto-associate with the current/relevant stop?

**Reliability note:** Unlike inbound webhooks, this is a standard outbound REST call **FreightID makes**, so FreightID is responsible for its own reliability: retry-with-backoff, a local `pending_alerts` queue so a TAI outage doesn't drop an alert silently, and logging of the call/response for audit.

### 4.2 Use Case 3 — Internal Lifecycle Events → TAI sync

| Event | Endpoint | Method | Key fields | Status |
|---|---|---|---|---|
| Driver assigned | *(unclear — see below)* | — | — | **⏸ ON HOLD, see §5** |
| Driver identity verified | `POST /ShipmentActivityLogs` (Create Shipment Activity) | POST | `shipmentId`, `type: "Operations"` (or General), `description`, `privacy: "Public"` | ✅ Confirmed |
| Arrives at pickup | `PUT /Tracking/{shipmentStopId}` (Update Stop Dates and POD) | PUT | `actualPickupArrivalDateTime` | ✅ Confirmed |
| Shipment picked up | `PUT /Tracking/{shipmentStopId}` (Update Stop Dates and POD) | PUT | `actualPickupDepartureDateTime` | ✅ Confirmed |
| Shipment in transit | `PUT /Tracking` (Update Tracking) | PUT | `trackingUpdate.shipmentStatus: "In Transit"` | ✅ Confirmed |
| Shipment delivered | `PUT /Tracking` (Update Tracking) | PUT | `trackingUpdate.shipmentStatus: "Delivered"`, `proofOfDeliveryArrivalDateTime`, `proofOfDeliveryDepartureDateTime` | ✅ Confirmed |
| POD captured | `PUT /Tracking` and/or `PUT /Tracking/{shipmentStopId}` | PUT | `proofOfDeliverySignedBy` (available on both) | ✅ Confirmed |

**Distinction between the two tracking endpoints:**
- **`Update Tracking`** (`PUT /Tracking`, shipment-level) — carries the overall `shipmentStatus` enum (`Quote, Committed, Ready, Sent, Dispatched, In Transit, Out for Delivery, Delivered, Complete, Canceled`) plus full POD timestamp pair. Use for any overall status change.
- **`Update Stop Dates and POD`** (`PUT /Tracking/{shipmentStopId}`, stop-level) — no `shipmentStatus` field; just arrival/departure timestamps + POD signature, scoped to one specific stop. Use for multi-stop shipments where the event must attach to the correct stop.

### 4.3 Reference: relevant schema enums (from `Update Tracking` / `Create Shipment Changes`)

- `shipmentStatus` enum: `Quote, Committed, Ready, Sent, Dispatched, In Transit, Out for Delivery, Delivered, Complete, Canceled`
- Driver-related fields exist only as **shipment reference numbers**, not a first-class entity:
  - `"Driver Name"`, `"Driver Cell Phone Number"`, `"Secondary Driver Name"`, `"Secondary Driver Cell Phone Number"`
- `PublicAPIShipmentDetails` also exposes `driverCellPhoneNumber` directly at the top level.
- `ShipmentActivityLogRequest.type` enum: `Receivable, Payable, Pricing, Operations, General, Status Change, Audit, Claims, Email, External Communications`
- `ShipmentActivityLogRequest.privacy` enum: `Public, Private`

---

## 5. ⏸ HELD FOR CLIENT CONFIRMATION — Driver Assignment

**Decision:** Driver-assignment sync to TAI is **paused** pending client/TAI confirmation. Do not implement the TAI-facing call yet.

### What we ruled out

- **`Assignments` API (`Create/Update/Get Staff Assignment`)** — confirmed **NOT for drivers**. Schema is `{ shipmentId, staffId, activityLogId }` — no name/role/type/license field. This is TAI's internal **staff** (dispatcher/rep) assignment, unrelated to drivers.

### What's still unconfirmed

- **`Create Shipment Changes`** (`POST /LogShipmentChanges`) — accepts `shipmentReferenceNumbersToMatch` + `shipmentToCompare.shipmentReferenceNumbers`, which *could* be used to set `"Driver Name"` / `"Driver Cell Phone Number"` reference values. However:
  - The endpoint is named "**Log** Shipment Change**s**" and its response schema is a bare, propertyless `object` — suggesting this may be an **audit/diff log only**, not a true persistence call.
  - **Not confirmed whether this endpoint actually updates the shipment record**, or just logs that a difference was detected.

### Question to send to TAI / client

> Does `POST /LogShipmentChanges` persist updated reference number values (e.g., Driver Name, Driver Cell Phone Number) onto the shipment record, or does it only create an audit-log entry of a detected diff without changing the shipment itself? If it's log-only, what is the correct endpoint to set/update driver reference numbers on a shipment?

### What to build now regardless

FreightID's **internal** state machine can still fire and record the "driver assigned" event locally (own DB, own `shipment_events` log, own UI) — it just should **not** call out to TAI for this specific event until the above is answered. Leave a clear `TODO` stub in `AssignmentService` for the TAI sync call.

---

## 6. Sections in TAI's API Not Yet Needed / Reference Only

From the TAI sidebar (`Shipments` group), for context on what else exists:

| Section | Relevance |
|---|---|
| **Shipping** (Create/Get Shipment, Create Carrier Rep, Create Shipment Changes, Update Tracking, Update Stop Dates and POD) | ✅ Core — used across use cases 1–4 |
| **Assignments** (Staff Assignment CRUD) | ❌ Internal TAI staff only — not drivers, not used |
| **Stops → Stop Alerts** (Create/Get/Resolve Shipment Stop Alert) | Possibly relevant as a **stop-scoped** alternative/companion to the shipment-level Alerts API (§4.1) — not yet needed but worth reviewing if alerts need to be pinned to a specific stop rather than the whole shipment |
| **Activity Log** (Create/Get Shipment Activity) | ✅ Used for "driver identity verified" and any other free-text lifecycle note |
| **Locations** (Get/Create Shipment Location) | Optional — for GPS/location sync; overlaps with `ShipmentLocationUpdateUrl` webhook (inbound). Only needed if FreightID needs to *push* location data to TAI rather than just receive it |
| Attachments, Commissions, Commodities, Loadboard, Pricing, Reference Numbers, Spot Quotes | Not relevant to use cases 1–4 (documents, billing/commission, cargo detail, load-matching, rates, reference IDs) |

---

## 7. FreightID — Architecture & Data Model Requirements

### Application requirements
- Backend (any stack)
- Persistent DB (Postgres recommended; SQLite fine for local dev)
- Basic UI/API to display shipment status
- HTTPS with TLS 1.2 enforced on the inbound webhook endpoint (TAI does not support TLS 1.3)
- Background job/queue system (for async webhook processing and outbound alert retries)

### Core data model

```
Shipment
  - id, shipment_type, service_level, status, mileage
  - pro_number, bol_number, po_number, shipper_reference
  - pickup: { company, address, city, state, zip, appointment_window }
  - receiver: { company, address, city, state, zip, delivery_window, appointment_time }
  - load: { description, quantity, pieces, weight, hazmat_flag, dimensions }
  - carrier_info, driver_info (local only, until §5 resolved for TAI sync)
  - created_at, updated_at

ShipmentEvents (audit trail)
  - shipment_id, event_type, timestamp, payload/details

ShipmentAlerts (local mirror of TAI alerts)
  - shipment_id, tai_alert_id, alert_type, resolved, created_at

PendingOutboundAlerts (reliability queue for use case 4)
  - shipment_id, alert_type(s), attempt_count, status, last_error

WebhookActivityLog (local mirror, since TAI's own log isn't visible to us)
  - source, raw_payload, received_at, auth_result, processing_outcome
```

### Two separate credential sets to manage
1. **Inbound webhook auth** — shared secret in `Authorization` header (or Basic Auth user/pass) — configured on TAI's side, validated by FreightID.
2. **Outbound REST API auth** — `x-api-key` header — used by FreightID when calling TAI's Public API.

---

## 8. Recommended Build Order

1. Data model + DB setup
2. Local **TAI webhook simulator** (mock sender mimicking real batching/timing behavior) — build and test without waiting on real TAI sandbox access
3. **Use case 1** — inbound `ShipmentCreateUrl` handler (auth check → 200 → async process → persist)
4. **Use case 2** — inbound `ShipmentDetailUpdateUrl` / `ShipmentStatusUpdateUrl` handlers
5. **Use case 3** — internal lifecycle state machine + confirmed outbound sync calls (`Tracking`, `Tracking/{stopId}`, `ShipmentActivityLogs`) — **excluding driver assignment**, per §5
6. **Use case 4** — `AlertService` + pending-alerts queue + `Alerts` / `Alerts/Resolved` calls

---

## 9. Open Questions / Action Items for Client or TAI

- [ ] **Driver assignment:** Does `POST /LogShipmentChanges` persist reference number changes, or just log them? What's the correct write path if not? *(blocking §5)*
- [ ] What are the valid `shipmentAlerts` string values accepted by `POST /Alerts`? Need the enum/reference list.
- [ ] Does `POST /Alerts` auto-associate the alert with the shipment's current/relevant stop, given the response includes `shipmentStopId` but the request doesn't accept one?
- [ ] Which `Version` (2 or 3) is configured for our `IntegrationSource` webhook settings — affects `Committed`/`Booked` and `Quote`/`Quoted` status parsing.
- [ ] Confirm whether Identity Provider (Jumio-style) questions apply here too — from earlier doc: address verification (unclear), license validity/MVR/CDLIS checks (yes), carrier authorization to haul freight (no), license plate verification (no — previously addressed).
- [ ] Should FreightID push status changes *back* to TAI for events not covered by webhooks, or is `Update Tracking`/`Update Stop Dates and POD` sufficient for all such sync needs?
