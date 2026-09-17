# Postman

Two unrelated collections live here: dummy **TAI** deliveries we send to ourselves, and real **Jumio**
calls we send outward. The Jumio one is at the bottom.

## TAI inbound webhooks

Dummy deliveries for use cases 1 and 2, standing in for TAI until sandbox access exists.

| File | What it is |
|---|---|
| `FreightID-TAI-Webhooks.postman_collection.json` | Import into Postman — 10 ready requests with bodies, assertions and notes |
| `sample-payloads.json` | The same dummy bodies as plain JSON, for curl / REST Client / hand-pasting |

### Setup

1. `npm run dev`
2. Postman → **Import** → drop in the collection file.
3. Collection → **Variables** tab, then set **one** credential pair to match your `.env`:
   - `taiBasicUser` + `taiBasicPassword` — mirrors `TAI_WEBHOOK_BASIC_USER` / `TAI_WEBHOOK_BASIC_PASSWORD`
   - `taiWebhookAuth` — mirrors `TAI_WEBHOOK_AUTH_TOKEN`, the whole string including `Bearer `

   Set **Current value**, not Initial value, so the secret is not synced to Postman's cloud.

> **Basic wins when both are configured** (findings §3). The server applies that precedence, and so
> does the collection's pre-request script. If `.env` has Basic vars, a static Bearer token is
> ignored and every request comes back 401.

Run the folders top to bottom — use case 2 updates the shipment use case 1 creates (`901455`).

### Reading the results

Almost everything returns **200**, including payloads that fail to process. That is deliberate:
TAI never re-sends a delivery, so a non-2xx would destroy the event outright. The real outcome lives
in the `webhook_events` table.

```
npm run db:studio
```

| Column | Meaning |
|---|---|
| `auth_result` | `AUTHORIZED` / `UNAUTHORIZED` (right scheme, wrong secret) / `MALFORMED` (wrong scheme) |
| `processing_status` | `PROCESSED`, `FAILED` (parsed, could not apply), `SKIPPED` (never parsed) |
| `error` | Why it failed |
| `raw_payload` | The body exactly as received — always kept, so anything can be replayed |

The three **Failure modes** requests are meant to fail. Expected results:

| Request | HTTP | `processing_status` | Point of it |
|---|---|---|---|
| Missing credential | 401 | `SKIPPED` | The only deliberate non-200 |
| Unmapped status | 200 | `FAILED` | Tripwire for a TAI `Version` 2/3 mismatch |
| No shipment id | 200 | `FAILED` | Nothing to match or create against |
| Malformed JSON | 200 | `SKIPPED` | Body kept in `raw_payload._unparsed` |

### Caveat

The field names in these payloads are **best guesses**. The findings doc pins down the transport
(POST, JSON, UTF-8, camelCase, ISO 8601 UTC — §3) but never the body schema, so
`src/lib/tai/payload.ts` reads each field through a list of aliases. Once a real TAI capture exists,
replace these bodies with it and prune the alias lists.

## Jumio auth & workflow retrieval

`FreightID-Jumio-Auth-Retrieval.postman_collection.json` — steps 1 and 4 of the flow in
`docs/Jumio_SDK_API_Flow.md`: get a bearer token, then read back a workflow execution result.

Steps 2 and 3 (create account, upload, finalize) are deliberately absent. This collection is for
inspecting a workflow **the app has already started**, which is what you actually want when a
verification looks wrong in the dashboard.

| Request | Call |
|---|---|
| Step 1 | `POST https://auth.amer-1.jumio.ai/oauth2/token` — Basic auth, `grant_type=client_credentials` |
| Step 4 | `GET https://retrieval.amer-1.jumio.ai/api/v1/accounts/{accountId}/workflow-executions/{workflowExecutionId}` — Bearer |

### Setup

1. Collection → **Variables** → set `clientId` and `clientSecret` from `JUMIO_CLIENT_ID` /
   `JUMIO_CLIENT_SECRET`. **Current value**, not Initial value — same rule as above.
2. Run **Step 1**. Its test script stores `accessToken` for you; the token lasts 3600s.
3. Set `accountId` and `workflowExecutionId` — the `jumio_account_id` and `jumio_workflow_id`
   columns on `driver_verifications` or `document_checks` (`npm run db:studio`).
4. Run **Step 4**. The console logs `status`, `decision` and `risk`.

> **These hit Jumio's live API and consume real transactions.** Nothing here is a local stub.

Three hosts, and they are not interchangeable: `auth.` issues tokens, `account.` creates workflows,
`retrieval.` returns results. All three come off `JUMIO_DATACENTER`, so a non-`amer-1` tenant means
changing `authHost` and `retrievalHost` to match.

A **404 on Step 4 usually means "not ready yet"**, not "does not exist" — Jumio can send its callback
a moment before the workflow is fetchable. Wait and re-send; `src/lib/jumio/retrieval.ts` does the
same at 1s / 3s / 8s / 10s. A **401** means the token expired: re-run Step 1.

Jumio requires a `User-Agent`. Postman appends its own unless you turn off auto-generated headers in
Settings, so if a call fails oddly, check what actually went over the wire first.
