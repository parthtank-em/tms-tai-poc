# Jumio Document Check Runbook — FreightID POC

Uploading a document file to Jumio and reading back what it extracts: endpoints,
payloads, the rows each step writes, and — importantly — what is **not** working yet.

Sibling of `Jumio_Integration_Runbook.md`, which covers driver identity verification.
The two share credentials, a callback endpoint and a token cache, and almost nothing
else. Read §3 before assuming they behave alike.

Reflects branch `jumio-integration` at commit `c19f2d3`, plus the uncommitted
document-check work.

> **Current state: the pipeline works end to end; the workflow behind it does not
> extract.** Jumio documents `10170` as "Doc Proof and Multi Doc Upload with image
> upload, but with NO data extraction and NO fraud checks" — so every upload returns
> `PASSED` with no data, exactly as specified. The code is verified correct against the
> docs and against live traffic; what is needed is a workflow with the Extraction
> capability configured. See §8.1.

---

# 1. What this is for

An operator uploads a supporting document — an address proof, a bank statement — and
sees Jumio's verdict plus whatever Jumio could read off it. One page, no driver record,
no consent journey, no camera.

It exists because the identity flow cannot answer this question. That flow is a live
capture journey owned by the driver; this is a back-office check of a piece of paper.

---

# 2. Tables involved

| Table | Holds | Key columns |
| --- | --- | --- |
| `document_checks` | One row per upload. Never overwritten. | `status`, `decision`, `risk_score`, `jumio_workflow_id`, `extracted_data` |
| `jumio_callback_events` | Shared with the identity flow. Gains `document_check_id`. | `workflow_execution_id`, `document_check_id`, `matched` |
| `drivers` | Optional link only. The column exists; no UI sets it. | `id` |

Reuses the `JumioVerificationStatus` and `JumioDecision` enums — the workflow envelope
is identical across both flows, only the extracted payload differs.

**The uploaded file is never stored.** It exists as bytes in the server process for the
duration of the upload call and is then dropped. `file_name`, `file_mime_type` and
`file_size_bytes` record what was submitted; the document itself does not persist. Same
rule the identity flow applies to ID images, for the same reason.

Migration: `prisma/migrations/20260909150000_jumio_document_check/`.

---

# 3. How this differs from identity verification

This is the difference that explains every other difference.

| | Identity verification | Document check |
| --- | --- | --- |
| Acquisition channel | Jumio's hosted Web Client | **API** — we upload the bytes |
| Who holds the file | Jumio, never us | Us, briefly, in memory |
| Credential category | `ID` + `SELFIE` | `DOCUMENT` |
| Credential declared up front | No — the user picks in the UI | **Yes** — country + type, exactly one each |
| Consent record | Required, gated on a consent screen | Not collected |
| Who finalizes | The Web Client, when the user submits | **We do**, explicitly |
| Workflow key | `JUMIO_WORKFLOW_KEY` | `JUMIO_DOCUMENT_WORKFLOW_KEY` |
| Redirect involved | Yes | No |

The Web Client performs steps 2–4 of §5 on its own. On the API channel nothing does, so
FreightID performs them.

---

# 4. Endpoints involved

| Endpoint | Direction | Auth |
| --- | --- | --- |
| `POST /api/jumio/documents` | Browser → us | Session cookie |
| `GET /api/jumio/documents/{id}` | Browser → us | Session cookie |
| `POST /api/jumio/callback` | Jumio → us | Secret in query string + IP allowlist |
| `POST auth.{dc}.jumio.ai/oauth2/token` | Us → Jumio | Basic (client id + secret) |
| `POST account.{dc}.jumio.ai/api/v1/accounts` | Us → Jumio | Bearer (tenant) |
| `POST` the credential part URL | Us → Jumio | Bearer (**transaction** token) |
| `PUT` the workflow-execution URL | Us → Jumio | Bearer (**transaction** token) |
| `GET retrieval.{dc}.jumio.ai/api/v1/accounts/…` | Us → Jumio | Bearer (tenant) |

The upload and finalize URLs are **never constructed**. They arrive fully parameterized
in the account reply and are used verbatim — they point at a different host from the
account API.

---

# 5. The seven steps

## Step 1 — Submit the form

`POST /api/jumio/documents`, `multipart/form-data`: `file`, `documentType`, `country`.

A route handler, not a server action. Server actions cap request bodies at 1MB by
default; Jumio accepts 15MB. Raising `serverActions.bodySizeLimit` for one form would
raise it for every action in the app.

Validated before anything leaves the building:

| Check | Rule |
| --- | --- |
| File present and non-empty | required |
| Size | ≤ 15MB (`MAX_UPLOAD_BYTES`) |
| MIME type | `image/jpeg`, `image/png`, `application/pdf` |
| Document type | must be a known code (`DOCUMENT_TYPES`) |
| Country | resolvable to ISO 3166-1 alpha-3 via `toAlpha3` |

The MIME check is repeated server-side deliberately: `accept` on a file input is a hint
to the file dialog, not a constraint anyone has to honour.

## Step 2 — Create the local row first

```text
INSERT INTO document_checks (status, jumio_workflow_key, requested_type,
                             requested_country, file_name, file_mime_type,
                             file_size_bytes)
VALUES ('INITIATED', …)
```

Its UUID becomes `customerInternalReference` — opaque, no PII. Creating it first also
means a failure at any later step lands somewhere visible instead of vanishing.

## Step 3 — Create the Jumio transaction

```http
POST https://account.{dc}.jumio.ai/api/v1/accounts
Authorization: Bearer <tenant token>
Content-Type: application/json
```

```json
{
  "customerInternalReference": "<document_checks.id>",
  "workflowDefinition": {
    "key": "<JUMIO_DOCUMENT_WORKFLOW_KEY>",
    "credentials": [
      {
        "category": "DOCUMENT",
        "country": { "predefinedType": "DEFINED", "values": ["IND"] },
        "type":    { "predefinedType": "DEFINED", "values": ["UB"] }
      }
    ]
  },
  "callbackUrl": "<JUMIO_CALLBACK_URL>?token=<secret>"
}
```

`country` and `type` are **mandatory, exactly one value each**. Jumio's reference: *"It
must have also include country and type fields, each with exactly one value in it."*
There is no "let Jumio decide" option for a DOCUMENT credential — Doc Proof picks the
matching template from that pair before the file arrives, which is why both are on the
form rather than defaulted.

The reply carries the upload targets:

```json
{
  "account": { "id": "d68cf2f1-…" },
  "workflowExecution": {
    "id": "abfc5c47-…",
    "credentials": [
      {
        "id": "08db70db-…",
        "category": "DOCUMENT",
        "api": {
          "token": "eyJhbGciOiJIUzUxMiIs…",
          "parts": { "document": "https://api.{dc}.jumio.ai/api/v1/accounts/…/parts" },
          "workflowExecution": "https://api.{dc}.jumio.ai/api/v1/accounts/…"
        }
      }
    ]
  }
}
```

`api.token` is **transaction-scoped**, not the tenant bearer. It authorizes this one
workflow execution and cannot be refreshed, which is why a 401 on an upload is not
retried.

The credential is selected by `category === "DOCUMENT"`, not by index — the reply lists
one entry per declared credential, and reading index zero breaks the day a workflow
gains a second one. **This is not hypothetical:** `10170` declares two credentials, and
the real retrieval lists them as `[{ "category": "DATA" }, { "category": "DOCUMENT" }]`.
Index zero would have uploaded the document to the prepared-data endpoint.

The `DATA` credential (`api.parts.prepared_data`) is for supporting values — name,
address, date of birth — supplied by us rather than read off a document. We upload none,
and finalize succeeds without it, so it is optional here. It becomes relevant only if a
risk signal such as Proof of Residency is added, which *consumes* an address rather than
extracting one.

Row advances to `ACQUISITION_STARTED`, storing `jumio_account_id`,
`jumio_workflow_id`, `jumio_credential_id`.

## Step 4 — Upload the file

```http
POST <api.parts.document>
Authorization: Bearer <transaction token>
Content-Type: multipart/form-data; boundary=…
```

Body: one part, field name `file`, with the original filename.

> **`POST`, not `PUT`.** A PUT here returns `405 Method Not Allowed`. Finalize, one step
> later, *is* a PUT. The two adjacent calls take opposite verbs — see §8.2.

`Content-Type` is never set by hand. `fetch` derives it from the `FormData` body
including the multipart boundary; setting it manually omits the boundary and Jumio
rejects the request.

## Step 5 — Finalize

```http
PUT <api.workflowExecution>
Authorization: Bearer <transaction token>
Content-Type: application/json

{}
```

Nothing else will do this. On the Web Client channel the user pressing submit finalizes
the transaction; on the API channel, without this call the workflow sits at `ACQUIRED`
until its token expires.

Row advances to `ACQUIRED` — Jumio has the document, and that is all we know. The
decision is not in yet.

## Step 6 — The callback, then retrieval

Jumio posts to the shared `/api/jumio/callback`. It has no idea the two flows differ and
the payload does not say, so the workflow execution id is looked up against **both**
`driver_verifications` and `document_checks`. They cannot collide — an execution id
belongs to exactly one transaction.

On `PROCESSED`, `syncDocumentCheckFromJumio` retrieves the result with the same backoff
the identity flow uses (4 attempts, ~22s).

## Step 7 — Map, persist, display

`mapDocumentWorkflowDetails` (`document-mapper.ts`) maps what it can name:

| Jumio | Column |
| --- | --- |
| `workflow.status` | `status` (unknown → `PROCESSING`) |
| `decision.type` | `decision` |
| `decision.risk.score` | `risk_score` (`-1` → null) |
| `extraction[].data.type` / `.subType` | `document_type` / `document_sub_type` |
| `extraction[].data.issuer` | `issuer` |
| `extraction[].data.firstName` + `.lastName`, else `.name` | `extracted_name` |
| `extraction[].data.address.*` | `address_line1`, `address_city`, `address_subdivision`, `address_postal_code`, `address_country`, `formatted_address` |
| `extraction[].data.documentNumber` | `document_number` |
| `extraction[].data.issuingDate` / `.expiryDate` | `issuing_date` / `expiry_date` |
| `extraction[].data` **verbatim** | `extracted_data` |
| every capability label | `decision_details` |

The verbatim blob is the point of the design. Supporting documents do not share a
shape — a utility bill and a bank statement agree on very little, and Jumio adds
document types without changing the API version. The named columns feed the UI; the blob
means a field nobody anticipated is visible rather than silently dropped.

The page prints both: a field table for reading, and the raw JSON underneath.

---

# 6. Polling, and why the page pulls as well as waits

`GET /api/jumio/documents/{id}` is what the page polls every 3s. It also **retrieves
from Jumio directly** when a check has been unsettled for more than 15 seconds.

That fallback is not redundancy for its own sake. A callback needs a publicly reachable
URL, which in development means a tunnel that may simply not be running — and a
demonstration that only works behind a tunnel is not much of a demonstration. Both paths
write the same rows from the same source, so whichever arrives first wins and the other
finds the work done.

Polling stops after 60 attempts (~3 minutes). A check unfinished by then is waiting on
Jumio, not on the page.

---

# 7. Failure handling summary

| Situation | What happens |
| --- | --- |
| Not configured (`JUMIO_DOCUMENT_WORKFLOW_KEY` unset) | The page says so up front instead of failing at upload |
| File too large / wrong type | Rejected in the route, 400, nothing sent to Jumio |
| Account creation rejected | Row marked `FAILED` with a sanitized reason; Jumio's own explanation to the log only |
| Upload or finalize rejected | Same — the row records the failure rather than pretending it did not happen |
| 401 on an upload | Not retried. The transaction token cannot be refreshed |
| 405 on any call | The `Allow` header is pulled into the logged error, so the right verb is stated rather than guessed |
| Callback for an unknown workflow | Stored, `matched = false`. Audit signal; touches nothing |
| The same callback again | Collides on the unique key. One row, 200 returned |
| Retrieval fails | Row falls back to `PROCESSING`, never to a rejection Jumio never issued |

---

# 8. Open issues

## 8.1 Workflow `10170` does not extract — by design

**This is a workflow-choice problem, not a bug and not a tenant misconfiguration.**
Jumio's own documentation is explicit:

> Workflow key 10170 activates Doc Proof and Multi Doc Upload with image upload, but
> with **NO data extraction and NO fraud checks**.

The Doc Proof quickstart's own documented retrieval response also shows
`"capabilities":{}`. Our tenant is behaving exactly as specified — `10170` accepts a
document and says so. It never claimed to read one.

Raw retrieval for a real upload (`abfc5c47-7234-4498-8fdd-4c0f6679ca57`):

```json
{
  "workflow": { "status": "PROCESSED", "definitionKey": "10170" },
  "decision": { "type": "PASSED", "details": { "label": "PASSED" }, "risk": { "score": 0 } },
  "credentials": [ { "category": "DATA" }, { "category": "DOCUMENT" } ],
  "capabilities": {}
}
```

`capabilities` is empty. No extraction, no usability, no image checks. Every uploaded
document returns `PASSED` / risk 0, and every extracted column stays null:

| File | Requested | Decision | `extracted_data` |
| --- | --- | --- | --- |
| `Parth-Tank-Aadhar Card.pdf` | `SSC` / IND | PASSED (0) | null |
| `ClaimCard.pdf` | `IC` / IND | PASSED (0) | null |

**That `PASSED` means "the upload was accepted", not "the document was checked."** It is
not a verification result in any useful sense.

### The fix

Extraction *is* available for DOCUMENT credentials — Jumio's Extraction capability
reference confirms it: *"Workflows that accept a DOCUMENT Credential pass it to the
Extraction capability."* It is not on by default, and it is not self-service:

> Work with your Jumio Account Representative to identify and configure the DOCUMENT
> types you intend to support, and the fields you expect to be extracted.

So the ask to Jumio has three parts, and the third is the one that gets missed:

1. A document workflow with the **Extraction** capability enabled
2. Configured for the **document types** we intend to support (see §9 — start with `UB`)
3. Configured for the **fields we expect back** (address, issuingDate, lastName …)

Then put that key in `JUMIO_DOCUMENT_WORKFLOW_KEY`. **No code change is needed** — the
mapper, columns, presenter and UI already handle extraction and are covered by tests.

### What extraction returns, once enabled

Per Jumio's Extraction reference, for DOCUMENT credentials:

| | Fields |
| --- | --- |
| Standard (most types) | `lastName`, `issuingDate`, `address` |
| Utility bill (`UB`) | + `dueDate` |
| Bank statement (`BS`) | + `accountNumber`, `swiftCode` |
| Credit card (`CCS`) | `panNumber`, `monthYearExpiry` (mandatory) |
| Social security card, USA (`SSC`) | `firstName`, `lastName`, `socialSecurityNumber`, `signatureAvailable` |

The `address` object: `line1`–`line5`, `city`, `subdivision`, `postalCode`, `country`,
`formattedAddress`.

Our mapper matches these names exactly. It maps `line1` and `line2` to columns; `line3`
–`line5`, `dueDate`, `accountNumber` and `swiftCode` have no column but land in
`extracted_data` verbatim, which is why that blob exists.

## 8.2 ~~The upload verb is undocumented~~ — resolved

Both open unknowns are now confirmed **by successful live traffic**, not just by
reasoning. Two uploads reached `PROCESSED`, which means the whole chain worked:

| Step | Confirmed |
| --- | --- |
| `POST` to the part URL | ✅ correct — `PUT` returns 405 |
| Multipart field name `file` | ✅ correct — a wrong name would 400 before finalize |
| `PUT {}` to finalize | ✅ correct — the workflow reached `PROCESSED` |
| Transaction token on both | ✅ correct |
| Retrieval `/api/v1/…` | ✅ current, not deprecated (the "V3" label is the product name) |

Jumio still does not publish the upload method or field name, so both stay as named
constants with comments. A 405 now also carries the `Allow` header into the logged
error, so the next method mismatch answers itself.

## 8.3 Aadhaar and PAN cannot go through this page

They are `ID`-category credentials, not `DOCUMENT`. Jumio's reference splits them:

- **`ID`** — *"a government-issued identification document such as a passport,
  identification card, or a driver's license"* → passport, driving licence, national ID,
  Aadhaar, PAN, voter ID
- **`DOCUMENT`** — *"images or PDF copies of documents such as bank statements, utility
  bills, or insurance cards"* → what this page uploads

No identity card appears anywhere in the DOCUMENT catalogue. Submitting an Aadhaar as
`SSC` — which was tested — matches it against the wrong template. It passed only because
no capability ran.

**To support them** would take three changes, none large:

1. Declare `category: "ID"` with `country: ["IND"]`, `type: ["ID_CARD"]`
2. Handle `front` / `back` parts instead of a single `document` part (PAN is
   single-sided; Aadhaar carries data on both)
3. A workflow key that accepts an ID credential over the API channel — Fastfill
   (`10172`, extraction only, no fraud checks) or an ID-verification workflow.
   `JUMIO_WORKFLOW_KEY` will not do: it expects a live capture journey

Aadhaar additionally carries UIDAI obligations around storing and masking the Aadhaar
number that do not apply to PAN or to utility bills. Worth settling with whoever owns
compliance before it goes near a real integration.

## 8.4 Transaction data is wiped quickly

The same retrieval shows `"wipedOutAt": "2026-09-09T09:55:43.385Z"` — roughly 14 minutes
after the workflow completed. Retrieval after that point returns nothing.

Retrieving on the callback keeps us well inside the window, and the §6 fallback fires at
15 seconds, so neither path is at risk. It does mean **old transactions cannot be read
back from Jumio** — whatever was mapped at sync time is all there will ever be. Worth
knowing before anyone plans a backfill.

## 8.5 Country availability per document type is unpublished

Jumio does not document which of the 23 DOCUMENT codes exist for which country, and the
catalogue skews Australian (Medicare card, seniors card, working-with-children check,
superannuation statement). The authoritative list for this tenant is in the Jumio
Portal: *Settings → Identity Verification → Supported IDs* and *Accepted IDs*.

---

# 9. Supported document types

Jumio's full DOCUMENT catalogue. ✅ marks the subset currently in the dropdown
(`DOCUMENT_TYPES` in `document-check.ts`).

| Code | Document | In dropdown |
| --- | --- | --- |
| `UB` | Utility bill | ✅ |
| `BS` | Bank statement | ✅ |
| `CCS` | Credit card statement | ✅ |
| `PB` | Phone bill | ✅ |
| `CB` | Council bill | ✅ |
| `LAG` | Lease agreement | ✅ |
| `TR` | Tax return | ✅ |
| `VT` | Vehicle title | ✅ |
| `IC` | Insurance card | ✅ |
| `SSC` | Social security card | ✅ |
| `BC` | Birth certificate | |
| `HCC` | Health care card | |
| `MEDC` | Medicare card | |
| `SEL` | School enrolment letter | |
| `SENC` | Seniors card | |
| `STUC` | Student card | |
| `WWCC` | Working with children check | |
| `CRC` | Corporate resolution certificate | |
| `LOAP` | Loan application | |
| `MOAP` | Mortgage application | |
| `SS` | Superannuation statement | |
| `TAC` | Trade association card | |
| `VC` | Voided check | |

Jumio notes: *"Other document types may be available, and custom documents may be
added"* — custom codes must be unique and cannot be `CUSTOM` or `OTHER`.

**For India**, the plausible address proofs to test extraction against once §8.1 is
resolved: `UB` (electricity/water/gas bill), `BS` (bank statement or passbook), `PB`
(phone/broadband bill), `LAG` (rent agreement), `TR` (ITR acknowledgement). A utility
bill is the most template-standardised and the best first test.

**File limits:** JPEG, PNG or PDF, 15MB total, 30 images or PDF pages — except credit
card statements, capped at 2.

---

# 10. Configuration

| Variable | Comes from | Used for |
| --- | --- | --- |
| `JUMIO_DOCUMENT_WORKFLOW_KEY` | Jumio Account Manager, or Workflow Designer | Which checks run on an uploaded document. **Must permit the API acquisition channel.** Unset → the page reports it |

Everything else — `JUMIO_CLIENT_ID`, `JUMIO_CLIENT_SECRET`, `JUMIO_DATACENTER`,
`JUMIO_CALLBACK_SECRET`, `JUMIO_CALLBACK_URL` — is shared with the identity flow and
documented in `Jumio_Integration_Runbook.md` §6 and `.env.example`.

Note that `JUMIO_WORKFLOW_KEY` and `JUMIO_DOCUMENT_WORKFLOW_KEY` are **different
workflows** and not interchangeable.

---

# 11. Where the code lives

```text
src/lib/jumio/
├── document-check.ts       the service: create → upload → finalize → retrieve
├── document-mapper.ts      Jumio response → FreightID representation
├── document-presenter.ts   FreightID representation → API/UI shape
├── client.ts               + uploadCredentialPart, finalizeWorkflowExecution
├── config.ts               + documentWorkflowKey, isJumioDocumentCheckConfigured
├── types.ts                + JumioCredentialRequest/Response, JumioDocumentExtractionData
└── verification.ts         recordJumioCallback now matches both flows

src/app/api/jumio/documents/
├── route.ts                POST — multipart upload
└── [id]/route.ts           GET — status + result, with the pull fallback

src/app/jumio-dashboard/documents/
├── page.tsx                the screen, and the not-configured notice
└── document-check-form.tsx the form, the poller, the printed response

src/app/api/jumio/callback/route.ts   dispatches to whichever flow matched
prisma/migrations/20260909150000_jumio_document_check/
```

Tests: `npm test` — 84 unit tests, offline. 10 cover `document-mapper` (missing
addresses, split vs whole names, unmapped fields, empty responses); 5 cover credential
acquisition in `client.test.ts` (the POST/PUT split, the `Allow` header on a 405, the
un-retried 401, empty 200 bodies).

---

# 12. Decision log

Why things are the way they are, so the next person does not have to re-derive it.

| Decision | Why |
| --- | --- |
| Separate `document_checks` table | Folding it into `driver_verifications` would leave half the columns always null and make `decision` mean two different things |
| Route handler, not server action | 1MB default action body limit vs Jumio's 15MB; raising it app-wide for one form is the wrong trade |
| The file is never persisted | Same rule as ID images. We store what Jumio read, not the document |
| `extracted_data` kept verbatim alongside mapped columns | Supporting documents have no fixed shape; a field we did not anticipate should be visible, not dropped |
| Credential selected by category, not index | The reply lists one entry per declared credential; index zero breaks on the second one |
| Upload URLs used verbatim | They are pre-parameterized and point at a different host from the account API |
| Status endpoint pulls as well as waits | A POC that only works when a tunnel is running is not a demonstration |
| Country + type kept on the form | Jumio requires both, and a wrong type silently matches the wrong template — worth a visible field |
| Driver link nullable and unused by the UI | The screen must work without a driver existing; the column is there for when that changes |
