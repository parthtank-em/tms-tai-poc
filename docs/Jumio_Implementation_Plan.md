# Jumio Integration Implementation Plan — FreightID POC

## 1. Objective

Integrate Jumio identity verification into the FreightID proof-of-concept application.

The POC should demonstrate this complete flow:

FreightID Driver Profile
→ Consent
→ Start Jumio verification
→ Jumio Web Client
→ Driver ID + selfie + liveness
→ Jumio processing
→ Jumio callback
→ Retrieval API
→ Persist verification result in Prisma/NeonDB
→ Display verification status in FreightID

### Scope from FreightID requirements

The Identity Provider use cases are:

- Government-issued ID verification
- ID authenticity
- Selfie-to-ID matching
- Liveness detection
- License/document data extraction
- License expiration/type extraction
- Risk-based verification
- Future pickup verification / re-authentication
- Future account recovery / suspicious-login verification

Do NOT implement MVR/DMV/CDLIS, carrier authority, or license-plate verification as part of the Jumio integration. These are separate capabilities/providers.

---

## 2. Important implementation principles

### 2.1 Use current Jumio API architecture

Do not copy older examples that use Basic Authentication.

Use OAuth 2.0:

1. FreightID backend authenticates with Jumio using Client ID + Client Secret.
2. Obtain an OAuth access token.
3. Cache/reuse the token until it expires.
4. Use `Authorization: Bearer <token>` for Jumio REST API calls.

Jumio documentation:
- https://documentation.jumio.ai/docs/developer-resources/API/authorization
- https://documentation.jumio.ai/docs/developer-resources/API/Integration_Intro

### 2.2 Use Jumio Web Client for the POC

Prefer the hosted/Web Client acquisition flow over implementing camera/document capture ourselves.

The backend creates the Jumio workflow/account and obtains the Web Client URL. The browser is redirected to Jumio.

Do not expose the Jumio Client Secret or other server credentials to the browser.

Documentation:
- https://documentation.jumio.ai/docs/developer-resources/API/credential-acquisition

### 2.3 Callback is not the complete result

Treat the Jumio callback as the notification that the workflow has reached a state.

After receiving the callback:

1. Validate the callback.
2. Persist the callback/event.
3. Return HTTP 200 quickly.
4. Retrieve the workflow/transaction details from Jumio Retrieval APIs.
5. Map the returned decision, risk, extraction, liveness and face-match data into the FreightID verification record.

Documentation:
- https://documentation.jumio.ai/docs/developer-resources/callback
- https://documentation.jumio.ai/docs/developer-resources/retrieval

### 2.4 Consent is required

Before collecting ID/biometric credentials, show an appropriate FreightID consent screen and record consent information required by Jumio.

Documentation:
- https://documentation.jumio.ai/docs/developer-resources/API/end-user-consent

### 2.5 Do not store raw ID/selfie images in FreightID

For the POC, store verification metadata and results only.

Avoid persisting raw credential images or unnecessary biometric data in NeonDB.

---

# 3. Expected architecture

```text
                         FreightID
                            |
                    Driver Profile
                            |
                    "Verify Identity"
                            |
                            v
                    Consent Screen
                            |
                            v
                 POST /api/jumio/start
                            |
                            v
                 FreightID Next.js Backend
                    |                 |
              OAuth Token        Jumio API Client
                    |                 |
                    +--------+--------+
                             |
                             v
                           Jumio
                             |
                         Web Client
                             |
                  ID + Selfie + Liveness
                             |
                             v
                    Jumio Workflow
                             |
                         Callback
                             |
                             v
                POST /api/jumio/callback
                             |
                             v
                      Retrieval API
                             |
                             v
                    Result Mapper
                             |
                             v
                       Prisma/NeonDB
                             |
                             v
                    FreightID Dashboard
```

---

# 4. Project structure

Use a structure similar to:

```text
src/
├── app/
│   ├── api/
│   │   └── jumio/
│   │       ├── start/
│   │       │   └── route.ts
│   │       ├── callback/
│   │       │   └── route.ts
│   │       └── status/
│   │           └── route.ts
│   │
│   ├── verification/
│   │   ├── consent/
│   │   ├── success/
│   │   ├── failed/
│   │   └── pending/
│
├── lib/
│   └── jumio/
│       ├── auth.ts
│       ├── client.ts
│       ├── accounts.ts
│       ├── retrieval.ts
│       ├── mapper.ts
│       └── types.ts
│
└── prisma/
    └── schema.prisma
```

Adapt this to the existing application's conventions rather than blindly creating duplicate structures.

---

# 5. Environment configuration

Add server-side environment variables.

Suggested:

```env
JUMIO_CLIENT_ID=
JUMIO_CLIENT_SECRET=

# Region-specific values/configuration
JUMIO_AUTH_URL=
JUMIO_API_BASE_URL=
JUMIO_RETRIEVAL_BASE_URL=

JUMIO_WORKFLOW_KEY=
JUMIO_CALLBACK_URL=

NEXT_PUBLIC_APP_URL=
```

Do not expose these through `NEXT_PUBLIC_*` except for values that are genuinely safe for the browser.

Do not commit credentials.

The Jumio region and endpoint values must come from the Jumio tenant/account configuration and current documentation. Do not invent endpoint values.

---

# 6. OAuth implementation

Create:

```text
src/lib/jumio/auth.ts
```

Implement:

```ts
getJumioAccessToken(): Promise<string>
```

Requirements:

- Use OAuth 2.0.
- Authenticate using Jumio Client ID and Client Secret.
- Keep credentials server-side.
- Cache the access token in memory for the POC.
- Refresh when expired.
- Avoid requesting a new token for every API call.
- Handle 401/token-expired responses safely.
- Never log the Client Secret or access token.

The token lifetime is documented by Jumio; implement expiration handling rather than assuming a permanent token.

---

# 7. Jumio API client

Create a small reusable client instead of scattering `fetch()` calls across route handlers.

Example responsibility:

```ts
class JumioClient {
  createAccount(...)
  retrieveWorkflow(...)
  retrieveWorkflowStatus(...)
}
```

The client should:

- Obtain a valid OAuth token.
- Add `Authorization: Bearer <token>`.
- Add required content headers.
- Handle non-2xx responses.
- Avoid logging sensitive payloads.
- Provide useful sanitized errors to the application.
- Keep Jumio-specific implementation details outside UI code.

Use the current Jumio API documentation as the source of truth for exact endpoint paths and request/response fields.

---

# 8. Start verification endpoint

Create:

```text
POST /api/jumio/start
```

Input:

```json
{
  "driverId": "internal-driver-id"
}
```

Implementation:

1. Authenticate/authorize the FreightID user if the existing application has authentication.
2. Validate that the driver exists.
3. Determine whether a verification is already active.
4. Obtain Jumio OAuth token.
5. Create the Jumio account/workflow transaction using the configured workflow key.
6. Provide the callback URL.
7. Provide the Web Client success/error URLs.
8. Provide the required consent information.
9. Persist the Jumio account/workflow identifiers.
10. Return the Jumio Web Client URL.

Return:

```json
{
  "redirectUrl": "..."
}
```

Do not return Jumio credentials or access tokens.

### Important reference identifiers

Use an opaque internal FreightID identifier for Jumio references.

Do not put PII such as:

- email
- phone number
- driver's license number
- name

into `customerInternalReference` or `userReference`.

---

# 9. Consent flow

Before starting credential acquisition, create a FreightID consent page.

Example:

```text
Verify your identity

FreightID needs to verify your identity before you can be approved.

The verification process may collect information from your
government-issued ID and biometric information such as a selfie.

[ View Privacy Notice ]

[ ] I consent to identity verification

[ Continue ]
```

The exact legal/privacy language should be supplied by the project/business/legal owner. Do not invent legal claims.

When the user continues:

- record the relevant consent timestamp;
- collect required user location/IP information according to the application's privacy requirements;
- send the required consent information to Jumio;
- then create/start the Jumio workflow.

---

# 10. Redirect to Jumio Web Client

After `/api/jumio/start` returns:

```json
{
  "redirectUrl": "..."
}
```

the frontend should redirect:

```ts
window.location.assign(redirectUrl);
```

Do not embed secrets in the URL.

Do not assume that returning to the success URL means verification passed.

---

# 11. Callback endpoint

Create:

```text
POST /api/jumio/callback
```

The callback handler should:

1. Parse the callback.
2. Validate that the callback is genuinely from Jumio using the mechanism supported/configured for the account.
3. Extract:
   - account ID
   - workflow execution ID
   - workflow status
   - user reference
4. Find the corresponding FreightID verification record.
5. Store a sanitized/raw callback event as appropriate for the POC.
6. Make processing idempotent.
7. Return HTTP 200 promptly.
8. Trigger retrieval of the actual transaction details.

Do not trust a browser success redirect as the source of truth.

Do not blindly accept arbitrary callback requests that can change a driver to VERIFIED.

Jumio documents callback host/IP information and callback behavior here:

https://documentation.jumio.ai/docs/developer-resources/callback

---

# 12. Callback idempotency

Assume callbacks can be retried or delivered more than once.

Use the Jumio workflow execution ID as the transaction identifier.

Recommended:

```prisma
model JumioCallbackEvent {
  id                  String   @id @default(cuid())
  workflowExecutionId String
  accountId           String?
  status              String
  payload             Json
  receivedAt          DateTime @default(now())

  @@index([workflowExecutionId])
}
```

Do not create duplicate verification records when the same callback arrives more than once.

---

# 13. Retrieval flow

After callback:

```text
Callback
   |
   v
workflowExecutionId
   |
   v
Jumio Retrieval API
   |
   v
Workflow details
   |
   +--> decision
   +--> risk score
   +--> extraction
   +--> liveness
   +--> face match
   +--> document information
```

Create:

```text
src/lib/jumio/retrieval.ts
```

Implement a reusable retrieval function.

The exact current endpoint and response schema must be taken from Jumio's Retrieval API documentation:

https://documentation.jumio.ai/docs/developer-resources/retrieval

Do not assume old endpoint paths or response structures from older examples.

---

# 14. Asynchronous processing

Do not assume Jumio processing completes synchronously.

Recommended state progression:

```text
INITIATED
    ↓
ACQUISITION_STARTED
    ↓
ACQUIRED
    ↓
PROCESSING
    ↓
PROCESSED
```

Possible terminal/error states include:

```text
PASSED
WARNING
REJECTED
SESSION_EXPIRED
TOKEN_EXPIRED
FAILED
```

Use Jumio's documented statuses and map them to FreightID's internal statuses.

For a POC, retrieval can be performed directly after the callback if the deployment environment supports it, or through a lightweight background/asynchronous mechanism.

If retrieval is not ready, implement controlled retry/backoff rather than tight polling.

---

# 15. Prisma data model

Improve the existing verification model to separate:

- FreightID driver
- Jumio account
- Jumio workflow execution
- verification status
- final decision
- extracted data
- capability results
- risk score

Suggested starting point:

```prisma
model DriverVerification {
  id                    String   @id @default(cuid())

  driverId              String

  jumioAccountId        String?
  jumioWorkflowId       String?
  jumioWorkflowKey      String?

  status                VerificationStatus @default(INITIATED)
  decision              VerificationDecision?
  riskScore             Float?

  extractedFirstName    String?
  extractedLastName     String?
  extractedDob          DateTime?
  licenseNumber         String?
  licenseExpiry         DateTime?
  issuingCountry        String?
  issuingState          String?

  livenessDecision      String?
  faceMatchDecision     String?

  decisionDetails       Json?
  rawCallback           Json?

  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  driver                Driver @relation(fields: [driverId], references: [id])

  @@index([driverId])
  @@index([jumioAccountId])
  @@index([jumioWorkflowId])
}

enum VerificationStatus {
  INITIATED
  ACQUISITION_STARTED
  ACQUIRED
  PROCESSING
  PROCESSED
  SESSION_EXPIRED
  TOKEN_EXPIRED
  FAILED
}

enum VerificationDecision {
  PASSED
  WARNING
  REJECTED
  NOT_EXECUTED
}
```

Before applying migrations, inspect the existing Prisma schema and adapt relations/naming to the actual project.

Do not overwrite existing models.

---

# 16. Result mapping

Create:

```text
src/lib/jumio/mapper.ts
```

The mapper should convert Jumio responses into a stable FreightID representation.

Conceptually:

```ts
type FreightIdVerificationResult = {
  status: ...
  decision: ...
  riskScore?: number
  documentType?: string
  firstName?: string
  lastName?: string
  dateOfBirth?: Date
  licenseNumber?: string
  licenseExpiry?: Date
  issuingCountry?: string
  issuingState?: string
  liveness?: string
  faceMatch?: string
}
```

Do not tightly couple UI components to the raw Jumio response structure.

This gives FreightID the option to replace Jumio later without rewriting the UI.

---

# 17. Risk score

Expose the Jumio risk score when available.

For the POC, show:

```text
Decision: PASSED
Risk Score: 12
```

Do not hardcode the Jumio decision thresholds in FreightID unless the business explicitly wants its own policy.

Jumio documents decision ranges and configurable thresholds. Use the returned decision as the vendor decision and keep FreightID policy separate.

---

# 18. FreightID UI

Create a verification section on the Driver Profile.

Example:

```text
Identity Verification

Status       VERIFIED
Decision     PASSED
Risk Score   12

Document     Driver License
Name         John Smith
DOB          18 Jan 1969
Expiry       18 Jan 2027
State        CA

Face Match   PASSED
Liveness     PASSED

[ Verify Again ]
```

For pending:

```text
Identity Verification

Status: Verification in progress...

We are waiting for the identity verification result.
```

For rejected:

```text
Identity Verification

Status: Verification failed

Decision: REJECTED

[ Try Again ]
```

Do not expose raw Jumio payloads to the normal user interface.

---

# 19. Verification status endpoint

Create:

```text
GET /api/jumio/status?driverId=...
```

Return a stable FreightID response:

```json
{
  "status": "PROCESSED",
  "decision": "PASSED",
  "riskScore": 12,
  "document": {
    "type": "DRIVING_LICENSE",
    "firstName": "John",
    "lastName": "Smith",
    "expiryDate": "2027-01-18"
  },
  "liveness": "PASSED",
  "faceMatch": "PASSED"
}
```

Only return fields that are appropriate for the current user/role.

---

# 20. Security requirements

Implement at minimum:

- OAuth2 instead of Basic Auth.
- Server-side Client ID/Secret.
- No secrets in frontend code.
- No access tokens in browser storage.
- Validate authenticated FreightID users before starting verification.
- Validate callback source according to Jumio's documented mechanism.
- Make callback processing idempotent.
- Validate that callback identifiers belong to a known FreightID verification.
- Do not trust success/error redirects.
- Do not log ID images, selfies, access tokens, Client Secret, or unnecessary PII.
- Avoid storing raw credential images.
- Use HTTPS for deployed callback URLs.
- Use environment variables for secrets.
- Sanitize errors returned to the frontend.

---

# 21. Error handling

Handle at least:

### OAuth failures

```text
401/403
→ log sanitized error
→ return "Jumio authentication unavailable"
```

### Account creation failure

```text
Jumio API error
→ do not create a fake verification
→ show retryable error
```

### Callback for unknown transaction

```text
Unknown workflowExecutionId
→ log security/audit event
→ do not update any driver
→ return appropriate response
```

### Duplicate callback

```text
Already processed
→ no duplicate record
→ return 200
```

### Jumio processing not ready

```text
Retrieval not ready
→ mark PROCESSING
→ retry with controlled backoff
```

### Session expired

```text
SESSION_EXPIRED
→ mark verification accordingly
→ allow user to start a new verification
```

---

# 22. Testing strategy

## Unit tests

Test:

- OAuth token caching.
- Jumio response mapping.
- Decision mapping.
- Extraction mapping.
- Invalid/missing Jumio fields.
- Duplicate callbacks.
- Unknown workflow IDs.
- Expired sessions.

## Integration tests

Test:

```text
Start verification
→ Jumio account created
→ IDs persisted
→ Web Client URL returned
```

and:

```text
Callback
→ workflow ID found
→ retrieval called
→ result mapped
→ Prisma updated
```

## Manual E2E test

Complete one real sandbox verification:

```text
Driver profile
→ Verify Identity
→ Consent
→ Jumio
→ License scan
→ Selfie
→ Liveness
→ Return to FreightID
→ Callback received
→ Retrieval completed
→ DB updated
→ UI shows result
```

---

# 23. Local development

Jumio needs to reach the callback endpoint.

`localhost` will not be directly reachable by Jumio.

Use a tunnel during development, for example:

```text
ngrok
```

or:

```text
Cloudflare Tunnel
```

Example:

```text
https://<temporary-domain>/api/jumio/callback
```

Configure the callback URL in the Jumio environment/tenant.

Do not hardcode the temporary URL into source code.

---

# 24. Mock Service / sandbox

Before building the complete real flow, investigate Jumio's Mock Service.

Documentation:

https://documentation.jumio.ai/docs/developer-resources/API/test-with-the-mock-service

Use it where practical to validate:

- OAuth/API integration
- account creation
- callback processing
- retrieval mapping
- database persistence

Then validate the complete Web Client journey against the Jumio sandbox.

---

# 25. Scope boundaries

### Implement now

- Jumio OAuth2
- Account/workflow creation
- Jumio Web Client redirect
- Consent
- Callback
- Callback validation
- Retrieval
- Decision
- Risk score
- Document extraction
- Liveness result
- Face-match result
- Prisma persistence
- Driver verification UI
- Retry/error handling
- Tests

### Do not implement now

- MVR/DMV/CDLIS verification
- FMCSA carrier-authority verification
- License plate verification
- GPS route monitoring
- PC*Miler integration
- TMS/TAI integration
- Production biometric retention architecture
- Complex pickup re-authentication
- Full account-recovery identity architecture

These can be added later.

---

# 26. Future architecture

Once the basic Jumio flow works, FreightID can combine multiple providers:

```text
                    Driver
                      |
          +-----------+-----------+
          |                       |
        Jumio                    MVR
          |                       |
  ID authenticity           License status
  Face match                Revoked?
  Liveness                  Suspended?
  Extraction                Valid?
  Risk
          |                       |
          +-----------+-----------+
                      |
                      v
             FreightID Identity
                  Decision
                      |
              +-------+-------+
              |               |
           VERIFIED       MANUAL REVIEW
```

Jumio should be treated as the identity/document/biometric verification component, not as the authoritative source for every driver/carrier requirement.

---

# 27. Definition of Done

The Jumio POC is complete when all of the following are true:

- [ ] Application can authenticate with Jumio using OAuth2.
- [ ] OAuth token is cached/reused.
- [ ] Driver can start verification from FreightID.
- [ ] Consent is collected before credential acquisition.
- [ ] Jumio Web Client opens successfully.
- [ ] Driver can complete the configured ID/selfie/liveness workflow.
- [ ] Jumio callback reaches FreightID.
- [ ] Callback is validated.
- [ ] Callback processing is idempotent.
- [ ] Jumio workflow is retrieved after callback.
- [ ] Decision is persisted.
- [ ] Risk score is persisted when available.
- [ ] Extracted identity/document fields are persisted.
- [ ] Liveness result is persisted when available.
- [ ] Face-match result is persisted when available.
- [ ] Driver verification UI displays the result.
- [ ] Failed/pending/expired states are handled.
- [ ] No Jumio secrets are exposed to the browser.
- [ ] No raw ID/selfie images are unnecessarily stored.
- [ ] Unit/integration tests cover the main paths.
- [ ] A real sandbox E2E verification has been completed.

---

# 28. Instructions for Claude Code

Before modifying code:

1. Inspect the existing Next.js project structure.
2. Inspect the existing Prisma schema.
3. Inspect existing authentication/authorization patterns.
4. Inspect existing API route conventions.
5. Inspect existing Driver model and Driver Profile UI.
6. Reuse existing components/utilities where appropriate.
7. Do not replace existing architecture unnecessarily.
8. Do not overwrite existing Prisma models.
9. Do not assume Jumio API field names from old examples.
10. Use the current Jumio documentation as the source of truth for exact API endpoints and request/response schemas.

Implementation should proceed incrementally:

### Phase 1
Configuration + OAuth

### Phase 2
Jumio client + account/workflow creation

### Phase 3
Consent + Web Client redirect

### Phase 4
Callback + validation + idempotency

### Phase 5
Retrieval + result mapping

### Phase 6
Prisma persistence

### Phase 7
Driver verification UI

### Phase 8
Testing + end-to-end sandbox verification

After each phase, verify that the application still builds and existing functionality is not broken.

---

# 29. Primary Jumio documentation

Use these as the authoritative references while implementing:

- Integration overview:
  https://documentation.jumio.ai/docs/developer-resources/API/Integration_Intro

- Authorization:
  https://documentation.jumio.ai/docs/developer-resources/API/authorization

- Integration prerequisites:
  https://documentation.jumio.ai/docs/developer-resources/API/integration-prerequisites

- Credential acquisition:
  https://documentation.jumio.ai/docs/developer-resources/API/credential-acquisition

- Account creation/update:
  https://documentation.jumio.ai/docs/developer-resources/API/CreateUpdateAccounts/creating-and-updating-accounts

- End-user consent:
  https://documentation.jumio.ai/docs/developer-resources/API/end-user-consent

- Callback:
  https://documentation.jumio.ai/docs/developer-resources/callback

- Retrieval:
  https://documentation.jumio.ai/docs/developer-resources/retrieval

- Mock Service:
  https://documentation.jumio.ai/docs/developer-resources/API/test-with-the-mock-service

---

## Final implementation rule

When documentation and this plan conflict, **the current Jumio documentation wins**.

Do not implement an API endpoint, field name, authentication mechanism, callback signature, or response structure solely because it appears in an older example or this plan. Verify it against the current Jumio documentation and the configured Jumio tenant.

The goal is a clean POC proving:

**FreightID → Jumio → verification → callback → retrieval → Prisma/NeonDB → FreightID UI.**
