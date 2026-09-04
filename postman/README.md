# Postman — TAI inbound webhooks

Dummy deliveries for use cases 1 and 2, standing in for TAI until sandbox access exists.

| File | What it is |
|---|---|
| `FreightID-TAI-Webhooks.postman_collection.json` | Import into Postman — 10 ready requests with bodies, assertions and notes |
| `sample-payloads.json` | The same dummy bodies as plain JSON, for curl / REST Client / hand-pasting |

## Setup

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

## Reading the results

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

## Caveat

The field names in these payloads are **best guesses**. The findings doc pins down the transport
(POST, JSON, UTF-8, camelCase, ISO 8601 UTC — §3) but never the body schema, so
`src/lib/tai/payload.ts` reads each field through a list of aliases. Once a real TAI capture exists,
replace these bodies with it and prune the alias lists.
