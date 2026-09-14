# Jumio Web SDK — API Flow

Every call in both flows: what the browser sends us, what we send Jumio, what
comes back, and how the token reaches the SDK.

Two flows, one SDK component. Only the server calls differ.

| Flow | Purpose | Jumio call |
| --- | --- | --- |
| Registration | Enrol a driver — ID document + selfie + liveness | `POST /api/v1/accounts` |
| Pickup | Re-check an enrolled driver — selfie only | `PUT /api/v1/accounts/{accountId}` |

`{dc}` below is `amer-1`, `emea-1` or `apac-1`, from `JUMIO_DATACENTER`.

---

# 1 · Registration

## 1.1 Browser → FreightID

```http
POST /api/jumio/start
Content-Type: application/json
Cookie: <session>
```
```json
{ "driverId": "b3f1c2e4-...", "consent": true }
```

Consent timestamp, IP and country are added server-side, never sent by the browser.

## 1.2 FreightID → Jumio · OAuth

```http
POST https://auth.{dc}.jumio.ai/oauth2/token
Authorization: Basic base64(JUMIO_CLIENT_ID:JUMIO_CLIENT_SECRET)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```
```json
{ "access_token": "eyJ...", "expires_in": 3600, "token_type": "Bearer" }
```

Cached in memory, refreshed 120 s before expiry.

## 1.3 FreightID → Jumio · create the transaction

```http
POST https://account.{dc}.jumio.ai/api/v1/accounts
Authorization: Bearer eyJ...
Content-Type: application/json
```
```json
{
  "customerInternalReference": "<verification UUID>",
  "userReference": "<driver UUID>",
  "workflowDefinition": { "key": "10549" },
  "callbackUrl": "https://<app>/api/jumio/callback?token=<JUMIO_CALLBACK_SECRET>",
  "web": {
    "successUrl": "https://<app>/jumio-dashboard/verifications/<id>",
    "errorUrl": "https://<app>/jumio-dashboard/verifications/<id>",
    "locale": "en"
  },
  "userConsent": {
    "userIp": "203.0.113.10",
    "userLocation": { "country": "USA", "state": "CA" },
    "consent": { "obtained": "yes", "obtainedAt": "2026-09-11T10:00:00.000Z" }
  }
}
```

```json
{
  "timestamp": "2026-09-11T10:00:01.221Z",
  "account": { "id": "572ac7b5-..." },
  "workflowExecution": { "id": "41f71912-..." },
  "web": { "href": "https://...jumio.ai/web/client?authorizationToken=..." },
  "sdk": { "token": "eyJhbGc..." }
}
```

Both acquisition handles arrive from this one call. `userLocation` is mandatory;
`state` is mandatory when the country is `USA`.

## 1.4 FreightID → Browser

```json
{
  "verificationId": "...",
  "acquisition": {
    "channel": "sdk",
    "token": "eyJhbGc...",
    "datacenter": "us",
    "locale": "en"
  }
}
```

Only the configured channel's handle is returned. On `redirect` it is
`{ "channel": "redirect", "redirectUrl": "<web.href>" }` instead.

## 1.5 Browser → Jumio SDK

`datacenter` is `JUMIO_DATACENTER` in the SDK's own spelling: `amer-1 → us`,
`emea-1 → eu`, `apac-1 → sgp`.

```html
<jumio-sdk dc="us" token="eyJhbGc..." locale="en"></jumio-sdk>
```

Built imperatively in `src/components/jumio/web-sdk.tsx`:

```ts
await import("@jumio/websdk");            // registers the custom element
const el = document.createElement("jumio-sdk");
el.setAttribute("dc", datacenter);
el.setAttribute("token", token);
el.setAttribute("locale", locale);
el.addEventListener("workflow:success", onDone);
el.addEventListener("workflow:failed", onDone);
container.append(el);
```

Events bubble and are composed:

| Event | Meaning |
| --- | --- |
| `workflow:start` | Capture began |
| `workflow:success` | Driver reached the end of the screens |
| `workflow:failed` | Jumio gave up; `detail.error.publicErrorCode` |
| `workflow:retry` | Handled inside the SDK |

`workflow:success` is **not** a result. It only triggers navigation to the
verification page, which reads state written by the callback.

## 1.6 Jumio → FreightID · callback

```http
POST /api/jumio/callback?token=<JUMIO_CALLBACK_SECRET>
```
```json
{
  "callbackSentAt": "2026-09-11T10:31:00.000Z",
  "workflowExecution": { "id": "41f71912-...", "definitionKey": "10549", "status": "PROCESSED" },
  "account": { "id": "572ac7b5-..." }
}
```
```json
{ "received": true, "processed": true }
```

Sequence: `ACQUISITION_STARTED` → `ACQUIRED` → `PROCESSED`. Gated by the shared
secret plus an IP allowlist. The callback carries a state, never the result.

## 1.7 FreightID → Jumio · retrieval

Triggered by the `PROCESSED` callback.

```http
GET https://retrieval.{dc}.jumio.ai/api/v1/accounts/572ac7b5-.../workflow-executions/41f71912-...
Authorization: Bearer eyJ...
```
```json
{
  "workflow": { "id": "41f71912-...", "status": "PROCESSED" },
  "completedAt": "2026-09-11T10:30:00.000Z",
  "decision": { "type": "PASSED", "details": { "label": "PASSED" }, "risk": { "score": 12 } },
  "capabilities": {
    "extraction": [{ "decision": { "type": "PASSED" }, "data": {
      "type": "DRIVING_LICENSE", "firstName": "John", "lastName": "Smith",
      "dateOfBirth": "1969-01-18", "documentNumber": "D1234567",
      "expiryDate": "2027-01-18", "issuingCountry": "USA", "state": "CA" } }],
    "similarity": [{ "decision": { "type": "PASSED" }, "data": { "similarity": "MATCH" } }],
    "liveness": [{ "decision": { "type": "PASSED" } }]
  },
  "credentials": [ "...image hrefs, never fetched..." ]
}
```

Retried with backoff (4 attempts, ~22 s) — `PROCESSED` can arrive just before the
result is fetchable.

## 1.8 Browser · polling

```http
GET /api/jumio/status?driverId=b3f1c2e4-...
```
```json
{
  "status": "PROCESSED",
  "decision": "PASSED",
  "riskScore": 12,
  "document": {
    "type": "DRIVING_LICENSE", "subType": "REGULAR_DRIVING_LICENSE",
    "firstName": "John", "lastName": "Smith",
    "expiryDate": "2027-01-18", "issuingCountry": "USA", "issuingState": "CA"
  },
  "liveness": "PASSED",
  "faceMatch": "MATCH",
  "startedAt": "2026-09-11T10:00:00.000Z",
  "completedAt": "2026-09-11T10:30:00.000Z"
}
```

Every 5 s, max 60 attempts. Refreshes the page when the status changes.

---

# 2 · Pickup verification

Same SDK, no document, no callback. Requires `JUMIO_AUTH_WORKFLOW_KEY`.

## 2.1 Browser → FreightID

```http
POST /api/jumio/pickup
```
```json
{ "driverId": "b3f1c2e4-..." }
```

The server resolves the account id from the driver's most recent **passed**
registration — that is the account holding their facemap.

## 2.2 FreightID → Jumio · re-authenticate

```http
PUT https://account.{dc}.jumio.ai/api/v1/accounts/572ac7b5-...
Authorization: Bearer eyJ...
Content-Type: application/json
```
```json
{
  "customerInternalReference": "pickup-<uuid>",
  "userReference": "<driver UUID>",
  "workflowDefinition": { "key": "10014" }
}
```
```json
{
  "timestamp": "2026-09-11T14:02:11.004Z",
  "account": { "id": "572ac7b5-..." },
  "workflowExecution": {
    "id": "9ab2f701-...",
    "credentials": [ { "category": "FACEMAP" }, { "category": "SELFIE" } ]
  },
  "sdk": { "token": "eyJhbGc..." }
}
```

`PUT` on the existing account, not `POST` to the collection — `POST` would enrol
a second, unrelated identity. No `userConsent`: consent was recorded at
registration, and the SDK shows its own consent step.

## 2.3 FreightID → Browser

```json
{
  "accountId": "572ac7b5-...",
  "workflowExecutionId": "9ab2f701-...",
  "acquisition": { "channel": "sdk", "token": "eyJhbGc...", "datacenter": "us", "locale": "en" }
}
```

## 2.4 Browser → Jumio SDK

Identical to §1.5 — same component, same attributes. The workflow declares only
`FACEMAP` and `SELFIE`, so the SDK skips the document steps and goes straight to
the selfie.

## 2.5 Browser → FreightID · result

On `workflow:success`, the modal fetches the outcome itself. There is no
callback because nothing was stored for one to match against.

```http
GET /api/jumio/pickup/result?accountId=572ac7b5-...&workflowExecutionId=9ab2f701-...
```
```json
{
  "decision": "PASSED",
  "riskScore": 8,
  "liveness": "PASSED",
  "faceMatch": "MATCH",
  "capabilities": { "liveness": "OK", "similarity": "MATCH", "workflow": "PASSED" },
  "completedAt": "2026-09-11T14:02:44.000Z",
  "settled": true
}
```

Served straight from the Retrieval API. Nothing is persisted, so closing the
modal loses the transaction.

---

# 3 · Cancelling a registration

The transaction exists the moment `/api/jumio/start` returns, so backing out has
to say so — otherwise the attempt stays active and blocks the next one.

```http
POST /api/jumio/cancel
```
```json
{ "verificationId": "..." }
```
```json
{ "cancelled": true }
```

Refused (`{ "cancelled": false }`) once Jumio has reported
`ACQUISITION_STARTED` — from then on the attempt belongs to the callback.

---

# 4 · Endpoint summary

## FreightID

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/jumio/start` | Session | Begin registration, return the SDK token |
| `POST /api/jumio/cancel` | Session | Abandon an attempt that never began capture |
| `GET /api/jumio/status` | Session | Current state for the poller |
| `POST /api/jumio/callback` | Secret + IP allowlist | Jumio's workflow notification |
| `POST /api/jumio/pickup` | Session | Begin re-authentication |
| `GET /api/jumio/pickup/result` | Session | Read a pickup outcome |

## Jumio

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST auth.{dc}.jumio.ai/oauth2/token` | Basic | Bearer token |
| `POST account.{dc}.jumio.ai/api/v1/accounts` | Bearer | Create a transaction |
| `PUT account.{dc}.jumio.ai/api/v1/accounts/{accountId}` | Bearer | Re-authenticate |
| `GET retrieval.{dc}.jumio.ai/api/v1/accounts/{accountId}/workflow-executions/{id}` | Bearer | The result |

## Configuration

| Variable | Used for |
| --- | --- |
| `JUMIO_CLIENT_ID` / `JUMIO_CLIENT_SECRET` | The bearer token |
| `JUMIO_DATACENTER` | All three hostnames, and the SDK's `dc` |
| `JUMIO_WORKFLOW_KEY` | Registration workflow |
| `JUMIO_AUTH_WORKFLOW_KEY` | Pickup workflow — unset hides the button |
| `JUMIO_CALLBACK_SECRET` / `JUMIO_CALLBACK_URL` | Callback authentication |
| `JUMIO_CONSENT_COUNTRY` / `JUMIO_CONSENT_STATE` | The mandatory consent record |
| `NEXT_PUBLIC_JUMIO_ACQUISITION_CHANNEL` | `sdk` or `redirect` |
| `NEXT_PUBLIC_APP_URL` | Web Client return URLs |
