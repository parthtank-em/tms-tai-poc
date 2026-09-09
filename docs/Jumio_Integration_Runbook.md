# Jumio Integration Runbook — FreightID POC

Every step from clicking **Add driver** to a verified result on screen, exactly as the
code does it today: endpoints, payloads, and the rows each step writes.

Companion to `Jumio_Implementation_Plan.md`, which is the specification. This document
is the description of what was actually built.

Reflects branch `jumio-integration` at commit `4c58ef3`.

---

# 1. Tables involved

| Table | Holds | Key columns |
| --- | --- | --- |
| `drivers` | The person. Shared with the TMS/TAI side; Jumio only updates the rollup. | `verification_status`, `verified_at` |
| `driver_verifications` | One row per attempt. Never overwritten — "verify again" adds a row. | `status`, `decision`, `risk_score`, `jumio_account_id`, `jumio_workflow_id` |
| `jumio_callback_events` | Every callback delivery, stored before it is interpreted. | `workflow_execution_id`, `status`, `callback_sent_at`, `matched` |

Enums: `JumioVerificationStatus` (`INITIATED`, `ACQUISITION_STARTED`, `ACQUIRED`,
`PROCESSING`, `PROCESSED`, `SESSION_EXPIRED`, `TOKEN_EXPIRED`, `FAILED`) and
`JumioDecision` (`PASSED`, `WARNING`, `REJECTED`, `NOT_EXECUTED`).

---

# 2. Endpoints involved

| Endpoint | Direction | Auth |
| --- | --- | --- |
| `POST /api/jumio/start` | Browser → us | Session cookie |
| `POST /api/jumio/callback` | Jumio → us | Secret in query string + IP allowlist |
| `GET /api/jumio/status` | Browser → us | Session cookie |
| `POST auth.{dc}.jumio.ai/oauth2/token` | Us → Jumio | Basic (client id + secret) |
| `POST account.{dc}.jumio.ai/api/v1/accounts` | Us → Jumio | Bearer |
| `GET retrieval.{dc}.jumio.ai/api/v1/accounts/…` | Us → Jumio | Bearer |

`{dc}` is `amer-1`, `emea-1` or `apac-1`, derived from `JUMIO_DATACENTER`.

---

# 3. What crosses the boundary, and which way

Two independent channels carry data *into* FreightID: the reply to a call we made, and
a callback Jumio initiates. Only the first table below is data we choose to disclose.

## 3.1 FreightID → Jumio (everything we send, in full)

| Field | Carries | Sent on |
| --- | --- | --- |
| Basic `clientId:clientSecret` | Our tenant credentials | Token call only |
| `customerInternalReference` | Our verification UUID — opaque | Account create |
| `userReference` | Our driver UUID — opaque | Account create |
| `workflowDefinition.key` | Which checks to run | Account create |
| `callbackUrl` | Where to notify us, plus our shared secret | Account create |
| `web.successUrl` / `web.errorUrl` | Where to send the browser back | Account create |
| `web.locale` | Language for the capture screens | Account create |
| `userConsent.userIp` | The consenting user's IP address | Account create |
| `userConsent.userLocation` | Country (ISO 3166-1 alpha-3) and, for the USA, state | Account create |
| `userConsent.consent` | That consent was obtained, and when | Account create |
| `tokenLifetime` | How long the capture link stays valid | Account create, optional |
| `accountId`, `workflowExecutionId` | Which transaction to read back | Retrieval URL |

**Never sent:** driver name, phone, email or licence number. Any shipment, carrier or
TMS data. Any image. Jumio learns two UUIDs, a jurisdiction and an IP — nothing that
identifies a driver on its own.

## 3.2 Jumio → FreightID (everything we receive)

| Field | Carries | Arrives via |
| --- | --- | --- |
| `access_token`, `expires_in` | Bearer token, 1 hour | Token reply |
| `account.id` | Jumio's id for this driver's account | Account reply |
| `workflowExecution.id` | The transaction id — our join key ever after | Account reply |
| `web.href` | One-time capture URL | Account reply |
| `sdk.token` | Web/mobile SDK token — received, unused today | Account reply |
| `callbackSentAt` | When Jumio sent the notification | Callback |
| `workflowExecution.status` | State reached — no result attached | Callback |
| `decision.type` | `PASSED` / `WARNING` / `REJECTED` / `NOT_EXECUTED` | Retrieval |
| `decision.risk.score` | 0–100, or −1 for never executed | Retrieval |
| `capabilities.extraction[].data` | Name, DOB, licence number, expiry, country, state, document type | Retrieval |
| `capabilities.similarity[].data` | Selfie matches the ID, or does not | Retrieval |
| `capabilities.liveness[].decision` | A real person was present | Retrieval |
| `credentials[].parts[].href` | Links to the ID scan and selfie | Retrieval |
| `acquisitionStatus`, `errorCode` | How the capture journey ended | Browser redirect |

**Received but deliberately dropped:** the image links are never followed and never
stored, so no ID scan or selfie enters our database. The redirect parameters are read
only to show a note on screen — they can never change a verification's state.

---

# 4. The twelve steps

## Step 1 — Add the driver

- **UI:** `/jumio-dashboard` → *Add driver*
- **Runs:** `createDriverAction` · `src/app/jumio-dashboard/driver-actions.ts`
- **Guard:** `requireSession()`

Only `name` is required. The state code is uppercased and clipped to two characters;
every other field is trimmed and length-capped.

```sql
INSERT INTO drivers (
  id,                  -- uuid, generated
  name,                -- required, <= 120 chars
  phone,               -- <= 40, nullable
  email,               -- <= 100, nullable
  license_number,      -- <= 40, nullable
  license_state,       -- <= 2, uppercased, nullable
  verification_status  -- = 'UNVERIFIED'
)
```

The dialog then pushes the browser to `/jumio-dashboard/drivers/{driverId}`.

## Step 2 — Collect consent

- **Page:** `/jumio-dashboard/drivers/[driverId]/consent`
- **Component:** `consent-form.tsx` (client)

Plain-language description of what will be collected, a checkbox, and a Continue button
disabled until it is ticked. **Nothing is written to the database at this point** — the
consent record is created server-side in step 4, so a tampered client cannot fabricate
one.

## Step 3 — Start the verification

- **Route:** `POST /api/jumio/start` · `src/app/api/jumio/start/route.ts`

Request from the browser:

```json
{
  "driverId": "09fc8c9a-d64e-4c48-9d95-2da845b39d5d",
  "consent": true,
  "country": "USA",
  "state": "CA"
}
```

`country` and `state` are optional overrides. Rejections, before anything is created:

```text
401  no session cookie
400  body is not JSON · driverId missing · consent !== true
503  consent country could not be resolved
```

The consent location comes from `JUMIO_CONSENT_COUNTRY` / `JUMIO_CONSENT_STATE` if set,
otherwise from `x-vercel-ip-country` (alpha-2, converted to alpha-3) and
`x-vercel-ip-country-region`. The IP comes from `x-forwarded-for`.

## Step 4 — Create the local row first

- **Runs:** `startDriverVerification` · `src/lib/jumio/verification.ts`

Two checks before writing: the driver exists, and no verification is already active
(any status other than `PROCESSED`, `SESSION_EXPIRED`, `TOKEN_EXPIRED`, `FAILED`).

```sql
INSERT INTO driver_verifications (
  id,                    -- uuid — becomes customerInternalReference
  driver_id,
  status,                -- = 'INITIATED'
  jumio_workflow_key,    -- from JUMIO_WORKFLOW_KEY
  consent_obtained_at,   -- server clock, not the browser's
  consent_ip,
  consent_country,
  consent_state,
  started_at, created_at
)
```

The row is created *before* calling Jumio precisely so its UUID can be the reference we
send.

## Step 5 — Get an access token

- **Runs:** `getJumioAccessToken` · `src/lib/jumio/auth.ts`
- **Skipped** when a cached token is still fresh

```http
POST https://auth.amer-1.jumio.ai/oauth2/token
Authorization: Basic base64(JUMIO_CLIENT_ID:JUMIO_CLIENT_SECRET)
Content-Type: application/x-www-form-urlencoded
Accept: application/json

grant_type=client_credentials
```

```json
{ "access_token": "…", "expires_in": 3600, "token_type": "Bearer" }
```

Cached in memory · refreshed **120 s** before expiry · concurrent callers share one
request · **15 s** timeout · a 401 later drops the cache and retries once.

No database write. The token is never logged and never leaves the server.

## Step 6 — Create the Jumio transaction

- **Runs:** `JumioClient.createAccount` · `src/lib/jumio/client.ts` · **30 s** timeout

```http
POST https://account.amer-1.jumio.ai/api/v1/accounts
Authorization: Bearer <token>
Content-Type: application/json
User-Agent: FreightID FreightID-POC/1.0
```

```json
{
  "customerInternalReference": "<driver_verifications.id>",
  "userReference": "<drivers.id>",
  "workflowDefinition": { "key": "<JUMIO_WORKFLOW_KEY>" },
  "callbackUrl": "https://tms-tai-poc.vercel.app/api/jumio/callback?token=<secret>",
  "web": {
    "successUrl": "https://…/jumio-dashboard/verifications/<verificationId>",
    "errorUrl": "https://…/jumio-dashboard/verifications/<verificationId>",
    "locale": "en"
  },
  "userConsent": {
    "userIp": "203.0.113.10",
    "userLocation": { "country": "USA", "state": "CA" },
    "consent": { "obtained": "yes", "obtainedAt": "2026-09-01T10:00:00.000Z" }
  }
}
```

Response:

```json
{
  "timestamp": "2026-09-01T10:00:01.221Z",
  "account": { "id": "572ac7b5-…" },
  "workflowExecution": { "id": "41f71912-…" },
  "web": { "href": "https://…jumio.ai/web/client?authorizationToken=<jwt>" },
  "sdk": { "token": "eyJhbGc…" }
}
```

`sdk.token` is unused today — it is what a Web SDK build would consume instead of
`web.href`.

```sql
UPDATE driver_verifications
   SET jumio_account_id  = account.id,
       jumio_workflow_id = workflowExecution.id
 WHERE id = <verificationId>;

UPDATE drivers SET verification_status = 'PENDING' WHERE id = <driverId>;
```

Returned to the browser:

```json
{ "redirectUrl": "<web.href>", "verificationId": "<uuid>" }
```

**If Jumio rejects the call:** the row is updated to `status = 'FAILED'` with the
sanitized reason and `completed_at` set — a real record of a failed start, never a
fabricated success. The browser gets `502`; Jumio's own explanation goes to the server
log with our secrets stripped out.

## Step 7 — Capture on Jumio's screens

- **Browser:** `window.location.assign(redirectUrl)`

Jumio's hosted Web Client handles the document scan, the selfie and the liveness
prompt. FreightID never touches a camera and never receives an image.

When the driver finishes, Jumio sends the browser back to the success or error URL —
both of which point at the same page. Jumio appends its own query parameters
(`acquisitionStatus`, `errorCode`, `transactionStatus`); ours carry none, because Jumio
rejects success/error URLs that contain a query string.

**Arriving back on the success URL means the driver finished the screens. Nothing
more.** The page reads the database; the redirect is never trusted.

## Step 8 — The callback arrives

- **Route:** `POST /api/jumio/callback?token=<secret>` · `src/app/api/jumio/callback/route.ts`

Body Jumio sends:

```json
{
  "callbackSentAt": "2026-09-01T10:31:00.000Z",
  "workflowExecution": {
    "id": "41f71912-…",
    "definitionKey": "10549",
    "status": "PROCESSED"
  },
  "account": { "id": "572ac7b5-…" }
}
```

`status` is one of `INITIATED`, `ACQUISITION_STARTED`, `ACQUIRED`, `PROCESSED`,
`SESSION_EXPIRED`, `TOKEN_EXPIRED`.

Validation runs before the body is even read: the `token` query parameter is compared to
`JUMIO_CALLBACK_SECRET` in constant time, then the source IP against Jumio's published
ranges when `JUMIO_CALLBACK_ENFORCE_IP=true`.

```text
503  integration not configured
401  bad or missing secret · unrecognised IP when enforcement is on  — nothing persisted
400  body is not JSON
```

```sql
INSERT INTO jumio_callback_events (
  workflow_execution_id, account_id, status, callback_sent_at,
  payload,          -- the raw body, verbatim
  verification_id,  -- matched by jumio_workflow_id, else NULL
  matched,          -- false when no verification matched
  remote_ip, received_at
)
-- UNIQUE (workflow_execution_id, status, callback_sent_at)
```

That unique key is the idempotency mechanism. A redelivery of the same notification
collides, the insert is caught, and the handler returns without doing the work twice.

```json
{ "received": true, "processed": true  }   // matched, work queued
{ "received": true, "processed": false }   // duplicate, or unknown workflow
```

The 200 goes out **before** any of the work below begins.

## Step 9 — Advance the status

- **Runs:** `applyCallbackStatus`, inside `after()` — after the response is sent

Each status has a rank; an incoming status only applies if it ranks higher than the
current one, so a late `ACQUIRED` landing after `PROCESSED` is ignored.

```text
INITIATED 0 → ACQUISITION_STARTED 1 → ACQUIRED 2 → PROCESSING 3 → PROCESSED 4
SESSION_EXPIRED 4 · TOKEN_EXPIRED 4 · FAILED 4     (unknown status → PROCESSING)
```

```sql
UPDATE driver_verifications
   SET status = <incoming>,
       completed_at = now()   -- only for terminal states other than PROCESSED
 WHERE id = <verificationId>;

-- when SESSION_EXPIRED or TOKEN_EXPIRED:
UPDATE drivers SET verification_status = 'UNVERIFIED' WHERE id = <driverId>;
```

Expiry is not rejection — the driver returns to unverified and is free to start again.

## Step 10 — Retrieve the actual result

- **Runs:** only when the callback status is `PROCESSED`
- **Backoff:** 4 attempts — 1 s, 3 s, 8 s, 10 s — on 429, 5xx, network errors and 404

```http
GET https://retrieval.amer-1.jumio.ai/api/v1/accounts/<accountId>/workflow-executions/<workflowExecutionId>
Authorization: Bearer <token>
```

The parts we read:

```json
{
  "workflow": { "id": "…", "status": "PROCESSED" },
  "completedAt": "2026-09-01T10:30:00.000Z",
  "decision": {
    "type": "PASSED",
    "details": { "label": "PASSED" },
    "risk": { "score": 12 }
  },
  "capabilities": {
    "extraction": [{ "data": {
        "type": "DRIVING_LICENSE", "subType": "REGULAR_DRIVING_LICENSE",
        "firstName": "John", "lastName": "Smith",
        "dateOfBirth": "1969-01-18", "expiryDate": "2027-01-18",
        "documentNumber": "D1234567", "issuingCountry": "USA", "state": "CA"
    }}],
    "similarity": [{ "data": { "similarity": "MATCH" } }],
    "liveness": [{ "decision": { "details": { "label": "OK" } } }]
  },
  "credentials": []
}
```

`credentials[]` carries links to the ID and selfie images. They are never followed and
never stored.

## Step 11 — Map and persist

- **Runs:** `mapWorkflowDetails` · `src/lib/jumio/mapper.ts`

| Jumio field | Column | Rule |
| --- | --- | --- |
| `workflow.status` | `status` | Unknown value → `PROCESSING` |
| `decision.type` | `decision` | Unknown → null |
| `decision.risk.score` | `risk_score` | Negative (−1) → null |
| `extraction[0].data.type` | `document_type` | |
| `extraction[0].data.subType` | `document_sub_type` | |
| `extraction[0].data.firstName` | `extracted_first_name` | |
| `extraction[0].data.lastName` | `extracted_last_name` | |
| `extraction[0].data.dateOfBirth` | `extracted_dob` | `YYYY-MM-DD` → UTC midnight |
| `extraction[0].data.documentNumber` | `license_number` | |
| `extraction[0].data.expiryDate` | `license_expiry` | `YYYY-MM-DD` → UTC midnight |
| `extraction[0].data.issuingCountry` | `issuing_country` | |
| `extraction[0].data.state` | `issuing_state` | |
| `similarity[0].data.similarity` | `face_match_decision` | Falls back to the capability label |
| `liveness[0].decision.details.label` | `liveness_decision` | |
| every capability label | `decision_details` | JSON, one label per capability |

```sql
UPDATE driver_verifications
   SET status, decision, risk_score, document_type, document_sub_type,
       extracted_first_name, extracted_last_name, extracted_dob,
       license_number, license_expiry, issuing_country, issuing_state,
       liveness_decision, face_match_decision, decision_details,
       retrieval_attempts = retrieval_attempts + <attempts>,
       retrieved_at = now(), error = NULL,
       completed_at                       -- only when status is PROCESSED
 WHERE id = <verificationId>;

UPDATE drivers
   SET verification_status = <rollup>,
       verified_at = now()                -- only when VERIFIED
 WHERE id = <driverId>;

UPDATE jumio_callback_events SET processed_at = now()
 WHERE verification_id = <id> AND status = <status> AND processed_at IS NULL;
```

The driver rollup:

```text
PROCESSED + PASSED                        → VERIFIED
PROCESSED + REJECTED or WARNING           → FAILED
PROCESSED + no decision                   → UNVERIFIED
SESSION_EXPIRED / TOKEN_EXPIRED / FAILED  → FAILED
anything still in flight                  → PENDING
```

**If retrieval fails:** the status is rolled back to `PROCESSING` and `completed_at`
cleared, with the reason in `error` and `retrieval_attempts` incremented. Left at
`PROCESSED` with no decision, the UI would read it as a rejection — telling an operator
a driver failed when we simply could not fetch the answer.

## Step 12 — Show the result

- **Pages:** `/jumio-dashboard/verifications/[id]` · `/jumio-dashboard/drivers/[driverId]`
- **Poll:** `GET /api/jumio/status?driverId=…` every 5 s, up to 60 attempts, refresh on change

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
  "liveness": "OK",
  "faceMatch": "MATCH",
  "startedAt": "2026-09-01T10:00:00.000Z",
  "completedAt": "2026-09-01T10:30:00.000Z"
}
```

Date of birth and licence number are deliberately absent from this JSON — a status poll
does not need to carry identity documents. The operator's driver profile renders them,
reading the same row through a fuller view.

`404` when the driver has never been verified · `401` without a session.

---

# 5. Failure handling summary

| Situation | What happens | Driver ends up |
| --- | --- | --- |
| Jumio auth fails | Sanitized error to the operator, detail in the log. No verification row created. | unchanged |
| Account creation rejected | Row marked `FAILED` with the reason — an honest record, not a fake success. | `UNVERIFIED` |
| Callback for an unknown workflow | Stored and flagged `matched = false` as an audit signal. No driver touched. | unchanged |
| The same callback again | Collides on the unique key. One row, 200 returned, no further work. | unchanged |
| Result not ready yet | Four retries with growing gaps, then the state falls back to `PROCESSING` to await the next callback. | `PENDING` |
| Session or token expired | Recorded as expiry, not failure. The driver can simply start again. | `UNVERIFIED` |
| Decision is `WARNING` | Not treated as a pass. Jumio puts it between passed and rejected; we treat "not clearly passed" as not verified. | `FAILED` |

---

# 6. Configuration

| Variable | Comes from | Used for |
| --- | --- | --- |
| `JUMIO_CLIENT_ID` / `JUMIO_CLIENT_SECRET` | Jumio portal, once OAuth2 is enabled | Getting the bearer token |
| `JUMIO_WORKFLOW_KEY` | Jumio Account Manager, or Workflow Designer | Which checks run |
| `JUMIO_DATACENTER` | Your tenant's region | Derives all three Jumio hostnames |
| `JUMIO_CALLBACK_SECRET` | You generate it | Authenticating callbacks |
| `JUMIO_CALLBACK_URL` | Your deployment's public origin | Where Jumio posts callbacks |
| `JUMIO_CALLBACK_ENFORCE_IP` | `true` in a real deployment | Rejects callbacks from unpublished IPs |
| `JUMIO_CONSENT_COUNTRY` / `JUMIO_CONSENT_STATE` | You set it, or platform geolocation | The mandatory consent record |
| `NEXT_PUBLIC_APP_URL` | Your deployment's public origin | Building the Web Client return URLs |

See `.env.example` for the full annotated list.

---

# 7. Where the code lives

```text
src/lib/jumio/
├── config.ts          env parsing, per-datacenter hosts
├── auth.ts            OAuth2 + in-memory token cache
├── client.ts          REST client, one 401 retry, sanitized errors
├── types.ts           Jumio wire types (never imported outside this folder)
├── callback-auth.ts   callback secret + IP allowlist
├── retrieval.ts       retrieval with controlled backoff
├── mapper.ts          Jumio response → FreightID representation
├── presenter.ts       FreightID representation → API/UI shape
├── consent.ts         consent location resolution
└── verification.ts    the service: the only module that writes verification state

src/app/api/jumio/     start · callback · status
src/app/jumio-dashboard/  dashboard, driver profile, consent, result pages
src/components/jumio/  Jumio-specific badges
```

Tests: `npm test` (69 unit tests, offline) and `npm run test:integration`
(19 tests against a throwaway Neon branch — see `TEST_DATABASE_URL` in `.env.example`).
