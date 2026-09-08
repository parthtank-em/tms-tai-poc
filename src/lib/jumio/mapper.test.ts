import { describe, expect, it } from "vitest";

import {
  mapDecision,
  mapRiskScore,
  mapWorkflowDetails,
  mapWorkflowStatus,
  parseJumioDate,
  rollupDriverStatus,
} from "./mapper";

import type { JumioWorkflowDetails } from "./types";

/**
 * The mapper is the seam between Jumio's response and FreightID's model, so
 * these tests care most about the awkward inputs: fields Jumio omitted, values
 * it invented, and the sentinels that do not mean what they look like.
 */

/** A passed ID + selfie + liveness workflow, shaped as the docs describe it. */
const PASSED_WORKFLOW: JumioWorkflowDetails = {
  workflow: { id: "wf-1", status: "PROCESSED", definitionKey: "10549" },
  account: { id: "acc-1" },
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
    liveness: [{ decision: { type: "PASSED", details: { label: "OK" } }, data: { type: "JUMIO_STANDARD" } }],
  },
};

describe("mapWorkflowStatus", () => {
  it("maps the documented statuses", () => {
    expect(mapWorkflowStatus("PROCESSED")).toBe("PROCESSED");
    expect(mapWorkflowStatus("ACQUISITION_STARTED")).toBe("ACQUISITION_STARTED");
    expect(mapWorkflowStatus("SESSION_EXPIRED")).toBe("SESSION_EXPIRED");
  });

  it("treats an unknown or missing status as still in flight, never as a failure", () => {
    expect(mapWorkflowStatus("SOME_FUTURE_STATE")).toBe("PROCESSING");
    expect(mapWorkflowStatus(null)).toBe("PROCESSING");
    expect(mapWorkflowStatus(undefined)).toBe("PROCESSING");
  });
});

describe("mapDecision", () => {
  it("maps the four documented decisions", () => {
    expect(mapDecision("PASSED")).toBe("PASSED");
    expect(mapDecision("WARNING")).toBe("WARNING");
    expect(mapDecision("REJECTED")).toBe("REJECTED");
    expect(mapDecision("NOT_EXECUTED")).toBe("NOT_EXECUTED");
  });

  it("returns null rather than guessing at an unknown decision", () => {
    expect(mapDecision("MAYBE")).toBeNull();
    expect(mapDecision(undefined)).toBeNull();
  });
});

describe("mapRiskScore", () => {
  it("keeps a real score, including zero", () => {
    expect(mapRiskScore(0)).toBe(0);
    expect(mapRiskScore(12)).toBe(12);
    expect(mapRiskScore(100)).toBe(100);
  });

  it("drops the -1 'never executed' sentinel instead of storing it as a score", () => {
    expect(mapRiskScore(-1)).toBeNull();
  });

  it("drops absent and non-numeric values", () => {
    expect(mapRiskScore(undefined)).toBeNull();
    expect(mapRiskScore(Number.NaN)).toBeNull();
  });
});

describe("parseJumioDate", () => {
  it("parses a document date at midnight UTC", () => {
    expect(parseJumioDate("2027-01-18")?.toISOString()).toBe("2027-01-18T00:00:00.000Z");
  });

  it("rejects anything that is not a plain calendar date", () => {
    expect(parseJumioDate("18/01/2027")).toBeNull();
    expect(parseJumioDate("")).toBeNull();
    expect(parseJumioDate(undefined)).toBeNull();
  });
});

describe("mapWorkflowDetails", () => {
  it("maps a passed workflow into the FreightID shape", () => {
    const result = mapWorkflowDetails(PASSED_WORKFLOW);

    expect(result.status).toBe("PROCESSED");
    expect(result.decision).toBe("PASSED");
    expect(result.riskScore).toBe(12);
    expect(result.documentType).toBe("DRIVING_LICENSE");
    expect(result.firstName).toBe("John");
    expect(result.lastName).toBe("Smith");
    expect(result.licenseNumber).toBe("D1234567");
    expect(result.issuingState).toBe("CA");
    expect(result.issuingCountry).toBe("USA");
    expect(result.dateOfBirth?.toISOString()).toBe("1969-01-18T00:00:00.000Z");
    expect(result.licenseExpiry?.toISOString()).toBe("2027-01-18T00:00:00.000Z");
    expect(result.faceMatch).toBe("MATCH");
    expect(result.liveness).toBe("OK");
    expect(result.completedAt?.toISOString()).toBe("2026-09-01T10:30:00.000Z");
  });

  it("collects one label per capability for the detail view", () => {
    const result = mapWorkflowDetails(PASSED_WORKFLOW);

    expect(result.decisionDetails).toMatchObject({
      extraction: "OK",
      similarity: "MATCH",
      liveness: "OK",
      workflow: "PASSED",
    });
  });

  it("survives a response with no capabilities and no decision", () => {
    const result = mapWorkflowDetails({ workflow: { status: "ACQUIRED" } });

    expect(result.status).toBe("ACQUIRED");
    expect(result.decision).toBeNull();
    expect(result.riskScore).toBeNull();
    expect(result.firstName).toBeNull();
    expect(result.faceMatch).toBeNull();
    expect(result.decisionDetails).toEqual({});
  });

  it("survives an entirely empty response", () => {
    const result = mapWorkflowDetails({});

    expect(result.status).toBe("PROCESSING");
    expect(result.completedAt).toBeNull();
  });

  it("prefers the similarity datum over the capability label for face match", () => {
    const result = mapWorkflowDetails({
      capabilities: {
        similarity: [
          { decision: { type: "REJECTED", details: { label: "REJECTED" } }, data: { similarity: "MISMATCH" } },
        ],
      },
    });

    expect(result.faceMatch).toBe("MISMATCH");
  });
});

describe("rollupDriverStatus", () => {
  const base = mapWorkflowDetails(PASSED_WORKFLOW);

  it("verifies a driver only on a passed decision", () => {
    expect(rollupDriverStatus(base)).toBe("VERIFIED");
  });

  it("does not verify a driver on WARNING", () => {
    expect(rollupDriverStatus({ ...base, decision: "WARNING" })).toBe("FAILED");
  });

  it("fails a rejected decision", () => {
    expect(rollupDriverStatus({ ...base, decision: "REJECTED" })).toBe("FAILED");
  });

  it("keeps an in-flight workflow pending", () => {
    expect(rollupDriverStatus({ ...base, status: "ACQUIRED", decision: null })).toBe("PENDING");
    expect(rollupDriverStatus({ ...base, status: "PROCESSING", decision: null })).toBe("PENDING");
  });

  it("fails an expired session", () => {
    expect(rollupDriverStatus({ ...base, status: "SESSION_EXPIRED", decision: null })).toBe("FAILED");
    expect(rollupDriverStatus({ ...base, status: "TOKEN_EXPIRED", decision: null })).toBe("FAILED");
  });

  it("leaves a processed-but-undecided workflow unverified", () => {
    expect(rollupDriverStatus({ ...base, decision: null })).toBe("UNVERIFIED");
  });
});
