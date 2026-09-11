import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { JumioApiError, type JumioClient } from "./client";
import {
  applyCallbackStatus,
  findActiveVerification,
  latestVerification,
  recordJumioCallback,
  startDriverVerification,
  syncVerificationFromJumio,
  type ConsentInput,
} from "./verification";

import { prisma } from "@/lib/prisma";

import type { JumioCallbackPayload, JumioWorkflowDetails } from "./types";

/**
 * The service layer against a real Postgres (§22).
 *
 * Jumio is always stubbed — these tests prove *our* rules: what gets persisted,
 * what a duplicate callback does, what happens to a driver when a workflow the
 * database has never heard of arrives. Those rules live in the interaction
 * between the code and the schema's constraints, which is exactly what a unit
 * test with a mocked Prisma cannot check.
 *
 * Every row these tests create is deleted afterwards; the branch is a copy of
 * real data, so nothing else is touched.
 */

const CONSENT: ConsentInput = {
  obtainedAt: new Date("2026-09-01T10:00:00.000Z"),
  ip: "203.0.113.10",
  country: "USA",
  state: "CA",
};

/** Rows created by this suite, torn down in reverse order of creation. */
const createdDriverIds: string[] = [];

async function createDriver(name = "Integration Test Driver"): Promise<string> {
  const driver = await prisma.driver.create({
    data: { name, verificationStatus: "UNVERIFIED" },
    select: { id: true },
  });

  createdDriverIds.push(driver.id);
  return driver.id;
}

/** A stub standing in for the Jumio REST client. Nothing leaves the process. */
function stubClient(overrides: {
  createAccount?: JumioClient["createAccount"];
  retrieveWorkflow?: JumioClient["retrieveWorkflow"];
}): JumioClient {
  return {
    createAccount:
      overrides.createAccount ??
      (async () => ({
        account: { id: `acc-${crypto.randomUUID()}` },
        workflowExecution: { id: `wf-${crypto.randomUUID()}` },
        // A real account reply carries both acquisition handles; the suite runs
        // on the SDK channel, so `sdk.token` is the one that has to be there.
        web: { href: "https://web.amer-1.jumio.ai/web/client?authorizationToken=jwt" },
        sdk: { token: `sdk-${crypto.randomUUID()}` },
      })),
    retrieveWorkflow: overrides.retrieveWorkflow ?? (async () => ({})),
  } as unknown as JumioClient;
}

function passedWorkflow(workflowId: string): JumioWorkflowDetails {
  return {
    workflow: { id: workflowId, status: "PROCESSED", definitionKey: "10549" },
    completedAt: "2026-09-01T10:30:00.000Z",
    decision: { type: "PASSED", details: { label: "PASSED" }, risk: { score: 12 } },
    capabilities: {
      extraction: [
        {
          decision: { type: "PASSED", details: { label: "OK" } },
          data: {
            type: "DRIVING_LICENSE",
            subType: "REGULAR_DRIVING_LICENSE",
            issuingCountry: "USA",
            firstName: "John",
            lastName: "Smith",
            dateOfBirth: "1969-01-18",
            expiryDate: "2027-01-18",
            documentNumber: "D1234567",
            state: "CA",
          },
        },
      ],
      similarity: [
        { decision: { type: "PASSED", details: { label: "MATCH" } }, data: { similarity: "MATCH" } },
      ],
      liveness: [{ decision: { type: "PASSED", details: { label: "OK" } } }],
    },
  };
}

function callbackFor(
  workflowExecutionId: string,
  status: string,
  sentAt = "2026-09-01T10:31:00.000Z",
): JumioCallbackPayload {
  return {
    callbackSentAt: sentAt,
    workflowExecution: { id: workflowExecutionId, status, definitionKey: "10549" },
    account: { id: "acc-1" },
  };
}

beforeAll(async () => {
  // Fail loudly rather than testing nothing if the branch is unreachable.
  await prisma.$queryRaw`SELECT 1`;
});

afterEach(async () => {
  if (createdDriverIds.length === 0) return;

  // Callback events are SetNull on verification, so they outlive the cascade
  // and have to go explicitly.
  const verifications = await prisma.driverVerification.findMany({
    where: { driverId: { in: createdDriverIds } },
    select: { id: true, jumioWorkflowId: true },
  });

  const workflowIds = verifications
    .map((verification) => verification.jumioWorkflowId)
    .filter((id): id is string => Boolean(id));

  await prisma.jumioCallbackEvent.deleteMany({
    where: {
      OR: [
        { verificationId: { in: verifications.map((verification) => verification.id) } },
        ...(workflowIds.length ? [{ workflowExecutionId: { in: workflowIds } }] : []),
      ],
    },
  });

  await prisma.driver.deleteMany({ where: { id: { in: createdDriverIds } } });
  createdDriverIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("start verification", () => {
  it("creates the Jumio account, persists the identifiers and returns the SDK token", async () => {
    const driverId = await createDriver();

    const result = await startDriverVerification(
      driverId,
      CONSENT,
      stubClient({
        async createAccount() {
          return {
            account: { id: "acc-integration-1" },
            workflowExecution: { id: "wf-integration-1" },
            web: { href: "https://web.amer-1.jumio.ai/web/client?authorizationToken=jwt" },
            sdk: { token: "sdk-token" },
          };
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.acquisition).toEqual({
      channel: "sdk",
      token: "sdk-token",
      datacenter: "us",
      locale: "en",
    });

    const stored = await prisma.driverVerification.findUniqueOrThrow({
      where: { id: result.verificationId },
    });

    expect(stored.jumioAccountId).toBe("acc-integration-1");
    expect(stored.jumioWorkflowId).toBe("wf-integration-1");
    expect(stored.jumioWorkflowKey).toBe("10549");
    expect(stored.status).toBe("INITIATED");
    expect(stored.consentObtainedAt?.toISOString()).toBe(CONSENT.obtainedAt.toISOString());
    expect(stored.consentIp).toBe(CONSENT.ip);
    expect(stored.consentCountry).toBe("USA");
    expect(stored.consentState).toBe("CA");

    const driver = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    expect(driver.verificationStatus).toBe("PENDING");
  });

  it("sends opaque references only — never driver PII", async () => {
    const driverId = await createDriver("Jane Personally Identifiable");
    let sentBody: { customerInternalReference?: string; userReference?: string } = {};

    const result = await startDriverVerification(
      driverId,
      CONSENT,
      stubClient({
        async createAccount(body) {
          sentBody = body;
          return {
            account: { id: "acc-2" },
            workflowExecution: { id: "wf-2" },
            web: { href: "https://web.amer-1.jumio.ai/web/client" },
            sdk: { token: "sdk-token" },
          };
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(sentBody.customerInternalReference).not.toContain("Jane");
    expect(sentBody.userReference).toBe(driverId);
    // The internal reference is the verification's own UUID.
    expect(sentBody.customerInternalReference).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("records a failed start instead of inventing a verification", async () => {
    const driverId = await createDriver();

    const result = await startDriverVerification(
      driverId,
      CONSENT,
      stubClient({
        async createAccount() {
          throw new JumioApiError("Jumio returned HTTP 400.", 400, false);
        },
      }),
    );

    expect(result.ok).toBe(false);

    const stored = await latestVerification(driverId);
    expect(stored?.status).toBe("FAILED");
    expect(stored?.error).toContain("400");
    expect(stored?.jumioAccountId).toBeNull();

    // A failed start must not leave the driver looking mid-verification.
    const driver = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    expect(driver.verificationStatus).toBe("UNVERIFIED");
  });

  it("refuses a second verification while one is still active", async () => {
    const driverId = await createDriver();

    await startDriverVerification(driverId, CONSENT, stubClient({}));
    const second = await startDriverVerification(driverId, CONSENT, stubClient({}));

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toContain("already in progress");

    expect(await prisma.driverVerification.count({ where: { driverId } })).toBe(1);
  });

  it("allows a new attempt once the previous one has finished", async () => {
    const driverId = await createDriver();

    const first = await startDriverVerification(driverId, CONSENT, stubClient({}));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await prisma.driverVerification.update({
      where: { id: first.verificationId },
      data: { status: "SESSION_EXPIRED" },
    });

    expect(await findActiveVerification(driverId)).toBeNull();

    const second = await startDriverVerification(driverId, CONSENT, stubClient({}));
    expect(second.ok).toBe(true);
    expect(await prisma.driverVerification.count({ where: { driverId } })).toBe(2);
  });

  it("rejects an unknown driver", async () => {
    const result = await startDriverVerification(crypto.randomUUID(), CONSENT, stubClient({}));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("Driver not found.");
  });

  it("fails the start when the workflow has no SDK channel enabled", async () => {
    const driverId = await createDriver();

    // Exactly what Jumio answers when the workflow definition offers the Web
    // Client but not the SDK: a complete, successful reply with no `sdk` block.
    const result = await startDriverVerification(
      driverId,
      CONSENT,
      stubClient({
        async createAccount() {
          return {
            account: { id: "acc-no-sdk" },
            workflowExecution: { id: "wf-no-sdk" },
            web: { href: "https://web.amer-1.jumio.ai/web/client" },
          };
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // The operator's fix names an environment variable, so it belongs in the
    // log, not in the message the row and the browser get (§20).
    expect(result.reason).not.toContain("JUMIO_ACQUISITION_CHANNEL");

    const stored = await latestVerification(driverId);
    expect(stored?.status).toBe("FAILED");

    const driver = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    expect(driver.verificationStatus).toBe("UNVERIFIED");
  });

  it("hands back the Web Client URL on the redirect channel", async () => {
    const driverId = await createDriver();
    process.env.NEXT_PUBLIC_JUMIO_ACQUISITION_CHANNEL = "redirect";

    try {
      const result = await startDriverVerification(
        driverId,
        CONSENT,
        stubClient({
          async createAccount() {
            return {
              account: { id: "acc-redirect" },
              workflowExecution: { id: "wf-redirect" },
              web: { href: "https://web.amer-1.jumio.ai/web/client?authorizationToken=jwt" },
              sdk: { token: "sdk-token" },
            };
          },
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Both handles were on the wire; only the configured one comes back, so
      // the SDK token never reaches a browser that has no SDK to redeem it.
      expect(result.acquisition).toEqual({
        channel: "redirect",
        redirectUrl: "https://web.amer-1.jumio.ai/web/client?authorizationToken=jwt",
      });
    } finally {
      process.env.NEXT_PUBLIC_JUMIO_ACQUISITION_CHANNEL = "sdk";
    }
  });
});

describe("callback into retrieval", () => {
  /** Start a verification and return its ids. */
  async function started() {
    const driverId = await createDriver();
    const workflowId = `wf-${crypto.randomUUID()}`;

    const result = await startDriverVerification(
      driverId,
      CONSENT,
      stubClient({
        async createAccount() {
          return {
            account: { id: `acc-${crypto.randomUUID()}` },
            workflowExecution: { id: workflowId },
            web: { href: "https://web.amer-1.jumio.ai/web/client" },
            sdk: { token: "sdk-token" },
          };
        },
      }),
    );

    if (!result.ok) throw new Error("fixture failed to start a verification");

    return { driverId, workflowId, verificationId: result.verificationId };
  }

  it("finds the workflow, retrieves the result, maps it and updates Prisma", async () => {
    const { driverId, workflowId, verificationId } = await started();

    const record = await recordJumioCallback(callbackFor(workflowId, "PROCESSED"), {
      remoteIp: "34.202.241.227",
    });

    expect(record.stored).toBe(true);
    expect(record.verificationId).toBe(verificationId);

    await applyCallbackStatus(verificationId, "PROCESSED");
    await syncVerificationFromJumio(
      verificationId,
      stubClient({ async retrieveWorkflow() { return passedWorkflow(workflowId); } }),
    );

    const stored = await prisma.driverVerification.findUniqueOrThrow({
      where: { id: verificationId },
    });

    expect(stored.status).toBe("PROCESSED");
    expect(stored.decision).toBe("PASSED");
    expect(stored.riskScore).toBe(12);
    expect(stored.documentType).toBe("DRIVING_LICENSE");
    expect(stored.extractedFirstName).toBe("John");
    expect(stored.extractedLastName).toBe("Smith");
    expect(stored.licenseNumber).toBe("D1234567");
    expect(stored.issuingState).toBe("CA");
    expect(stored.extractedDob?.toISOString()).toBe("1969-01-18T00:00:00.000Z");
    expect(stored.licenseExpiry?.toISOString()).toBe("2027-01-18T00:00:00.000Z");
    expect(stored.faceMatchDecision).toBe("MATCH");
    expect(stored.livenessDecision).toBe("OK");
    expect(stored.retrievedAt).not.toBeNull();
    expect(stored.completedAt).not.toBeNull();

    const driver = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    expect(driver.verificationStatus).toBe("VERIFIED");
    expect(driver.verifiedAt).not.toBeNull();
  });

  it("stores no image data, only metadata", async () => {
    const { workflowId, verificationId } = await started();

    await syncVerificationFromJumio(
      verificationId,
      stubClient({
        async retrieveWorkflow() {
          return {
            ...passedWorkflow(workflowId),
            // Jumio hands back links to the ID and selfie images. We must not
            // follow them, and must not keep them.
            credentials: [
              { id: "cred-1", category: "ID", parts: [{ classifier: "FRONT", href: "https://…/parts/FRONT" }] },
            ],
          };
        },
      }),
    );

    const stored = await prisma.driverVerification.findUniqueOrThrow({
      where: { id: verificationId },
    });

    expect(JSON.stringify(stored)).not.toContain("parts/FRONT");
    expect(JSON.stringify(stored.decisionDetails)).not.toContain("href");
  });

  it("does not verify a driver on a WARNING decision", async () => {
    const { driverId, workflowId, verificationId } = await started();

    await syncVerificationFromJumio(
      verificationId,
      stubClient({
        async retrieveWorkflow() {
          const details = passedWorkflow(workflowId);
          return { ...details, decision: { type: "WARNING", details: { label: "WARNING" }, risk: { score: 55 } } };
        },
      }),
    );

    const driver = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    expect(driver.verificationStatus).toBe("FAILED");
    expect(driver.verifiedAt).toBeNull();
  });

  it("marks the verification PROCESSING when retrieval fails, not rejected", async () => {
    const { driverId, workflowId, verificationId } = await started();

    await applyCallbackStatus(verificationId, "PROCESSED");
    await syncVerificationFromJumio(
      verificationId,
      stubClient({
        async retrieveWorkflow() {
          throw new JumioApiError("Jumio returned HTTP 503.", 503, true);
        },
      }),
    );

    const stored = await prisma.driverVerification.findUniqueOrThrow({
      where: { id: verificationId },
    });

    // Left at PROCESSED with no decision, the UI would tell an operator this
    // driver was rejected — when all that happened is we could not fetch it.
    expect(stored.status).toBe("PROCESSING");
    expect(stored.decision).toBeNull();
    expect(stored.completedAt).toBeNull();
    expect(stored.error).toContain("503");
    expect(stored.retrievalAttempts).toBeGreaterThan(0);

    const driver = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    expect(driver.verificationStatus).toBe("PENDING");

    void workflowId;
  });
});

describe("duplicate callbacks", () => {
  it("stores one row and reports the redelivery, without a second verification", async () => {
    const driverId = await createDriver();
    const workflowId = `wf-${crypto.randomUUID()}`;

    await startDriverVerification(
      driverId,
      CONSENT,
      stubClient({
        async createAccount() {
          return {
            account: { id: "acc-dup" },
            workflowExecution: { id: workflowId },
            web: { href: "https://web.amer-1.jumio.ai/web/client" },
            sdk: { token: "sdk-token" },
          };
        },
      }),
    );

    const payload = callbackFor(workflowId, "PROCESSED");

    const first = await recordJumioCallback(payload, { remoteIp: "34.202.241.227" });
    const second = await recordJumioCallback(payload, { remoteIp: "34.202.241.227" });

    expect(first.stored).toBe(true);
    expect(second.stored).toBe(false);
    expect(second.verificationId).toBe(first.verificationId);

    expect(await prisma.jumioCallbackEvent.count({ where: { workflowExecutionId: workflowId } })).toBe(1);
    expect(await prisma.driverVerification.count({ where: { driverId } })).toBe(1);
  });

  it("treats a genuinely different state as a new delivery", async () => {
    const driverId = await createDriver();
    const workflowId = `wf-${crypto.randomUUID()}`;

    await startDriverVerification(
      driverId,
      CONSENT,
      stubClient({
        async createAccount() {
          return {
            account: { id: "acc-seq" },
            workflowExecution: { id: workflowId },
            web: { href: "https://web.amer-1.jumio.ai/web/client" },
            sdk: { token: "sdk-token" },
          };
        },
      }),
    );

    await recordJumioCallback(callbackFor(workflowId, "ACQUIRED", "2026-09-01T10:10:00.000Z"), {
      remoteIp: null,
    });
    await recordJumioCallback(callbackFor(workflowId, "PROCESSED", "2026-09-01T10:31:00.000Z"), {
      remoteIp: null,
    });

    expect(await prisma.jumioCallbackEvent.count({ where: { workflowExecutionId: workflowId } })).toBe(2);
  });
});

describe("unknown workflow ids", () => {
  it("records the delivery as unmatched and touches no driver", async () => {
    const driverId = await createDriver();
    const before = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });

    const strangerWorkflowId = `wf-stranger-${crypto.randomUUID()}`;
    const record = await recordJumioCallback(callbackFor(strangerWorkflowId, "PROCESSED"), {
      remoteIp: "198.51.100.7",
    });

    expect(record.stored).toBe(true);
    expect(record.verificationId).toBeNull();

    const event = await prisma.jumioCallbackEvent.findFirstOrThrow({
      where: { workflowExecutionId: strangerWorkflowId },
    });

    expect(event.matched).toBe(false);
    expect(event.verificationId).toBeNull();
    expect(event.remoteIp).toBe("198.51.100.7");

    const after = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    expect(after.verificationStatus).toBe(before.verificationStatus);

    await prisma.jumioCallbackEvent.deleteMany({
      where: { workflowExecutionId: strangerWorkflowId },
    });
  });

  it("records a callback with no workflow id at all", async () => {
    const record = await recordJumioCallback(
      { callbackSentAt: "2026-09-01T10:31:00.000Z", account: { id: "acc-x" } },
      { remoteIp: null },
    );

    expect(record.workflowExecutionId).toBeNull();

    const event = await prisma.jumioCallbackEvent.findFirstOrThrow({
      where: { workflowExecutionId: "", accountId: "acc-x" },
      orderBy: { receivedAt: "desc" },
    });

    expect(event.matched).toBe(false);
    expect(event.error).toContain("no workflowExecution.id");

    await prisma.jumioCallbackEvent.delete({ where: { id: event.id } });
  });
});

describe("expired sessions and out-of-order callbacks", () => {
  async function startedVerification() {
    const driverId = await createDriver();
    const workflowId = `wf-${crypto.randomUUID()}`;

    const result = await startDriverVerification(
      driverId,
      CONSENT,
      stubClient({
        async createAccount() {
          return {
            account: { id: "acc-exp" },
            workflowExecution: { id: workflowId },
            web: { href: "https://web.amer-1.jumio.ai/web/client" },
            sdk: { token: "sdk-token" },
          };
        },
      }),
    );

    if (!result.ok) throw new Error("fixture failed to start a verification");
    return { driverId, workflowId, verificationId: result.verificationId };
  }

  it("marks an expired session and frees the driver to start again", async () => {
    const { driverId, verificationId } = await startedVerification();

    await applyCallbackStatus(verificationId, "SESSION_EXPIRED");

    const stored = await prisma.driverVerification.findUniqueOrThrow({
      where: { id: verificationId },
    });

    expect(stored.status).toBe("SESSION_EXPIRED");
    expect(stored.completedAt).not.toBeNull();

    // Expiry is not rejection: the driver goes back to unverified, not failed.
    const driver = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    expect(driver.verificationStatus).toBe("UNVERIFIED");

    expect(await findActiveVerification(driverId)).toBeNull();

    const retry = await startDriverVerification(driverId, CONSENT, stubClient({}));
    expect(retry.ok).toBe(true);
  });

  it("handles TOKEN_EXPIRED the same way", async () => {
    const { driverId, verificationId } = await startedVerification();

    await applyCallbackStatus(verificationId, "TOKEN_EXPIRED");

    const driver = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    expect(driver.verificationStatus).toBe("UNVERIFIED");
    expect(await findActiveVerification(driverId)).toBeNull();
  });

  it("advances through the documented state progression", async () => {
    const { verificationId } = await startedVerification();

    for (const status of ["ACQUISITION_STARTED", "ACQUIRED", "PROCESSED"]) {
      await applyCallbackStatus(verificationId, status);
    }

    const stored = await prisma.driverVerification.findUniqueOrThrow({
      where: { id: verificationId },
    });

    expect(stored.status).toBe("PROCESSED");
  });

  it("never moves a verification backwards", async () => {
    const { verificationId } = await startedVerification();

    await applyCallbackStatus(verificationId, "PROCESSED");
    // A delayed ACQUIRED landing after the result must not undo it.
    await applyCallbackStatus(verificationId, "ACQUIRED");

    const stored = await prisma.driverVerification.findUniqueOrThrow({
      where: { id: verificationId },
    });

    expect(stored.status).toBe("PROCESSED");
  });

  it("ignores a status it does not recognise rather than regressing", async () => {
    const { verificationId } = await startedVerification();

    await applyCallbackStatus(verificationId, "ACQUIRED");
    await applyCallbackStatus(verificationId, "SOMETHING_NEW");

    const stored = await prisma.driverVerification.findUniqueOrThrow({
      where: { id: verificationId },
    });

    // Unknown maps to PROCESSING, which is forward of ACQUIRED — allowed.
    expect(stored.status).toBe("PROCESSING");
  });
});
