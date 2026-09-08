import { describe, expect, it } from "vitest";

import { toStatusResponse, toVerificationView, verificationPhase } from "./presenter";

/**
 * The presenter decides what leaves the building. The tests that matter are the
 * ones asserting what is *absent* from the JSON endpoint.
 */

const ROW = {
  id: "ver-1",
  status: "PROCESSED" as const,
  decision: "PASSED" as const,
  riskScore: 12,
  documentType: "DRIVING_LICENSE",
  documentSubType: "REGULAR_DRIVING_LICENSE",
  extractedFirstName: "John",
  extractedLastName: "Smith",
  extractedDob: new Date("1969-01-18T00:00:00.000Z"),
  licenseNumber: "D1234567",
  licenseExpiry: new Date("2027-01-18T00:00:00.000Z"),
  issuingCountry: "USA",
  issuingState: "CA",
  livenessDecision: "OK",
  faceMatchDecision: "MATCH",
  error: null,
  startedAt: new Date("2026-09-01T10:00:00.000Z"),
  completedAt: new Date("2026-09-01T10:30:00.000Z"),
};

describe("toStatusResponse", () => {
  it("returns the documented status shape", () => {
    const response = toStatusResponse(ROW);

    expect(response.status).toBe("PROCESSED");
    expect(response.decision).toBe("PASSED");
    expect(response.riskScore).toBe(12);
    expect(response.document.type).toBe("DRIVING_LICENSE");
    expect(response.document.expiryDate).toBe("2027-01-18");
    expect(response.liveness).toBe("OK");
    expect(response.faceMatch).toBe("MATCH");
  });

  it("keeps date of birth and licence number out of the API response", () => {
    const serialized = JSON.stringify(toStatusResponse(ROW));

    expect(serialized).not.toContain("1969-01-18");
    expect(serialized).not.toContain("D1234567");
  });

  it("carries no trace of the raw Jumio payload", () => {
    const response = toStatusResponse(ROW) as Record<string, unknown>;

    expect(response.capabilities).toBeUndefined();
    expect(response.decisionDetails).toBeUndefined();
    expect(response.rawCallback).toBeUndefined();
  });
});

describe("toVerificationView", () => {
  it("does include the document fields the operator screen exists to show", () => {
    const view = toVerificationView(ROW);

    expect(view.dateOfBirth).toBe("1969-01-18");
    expect(view.licenseNumber).toBe("D1234567");
  });
});

describe("verificationPhase", () => {
  it("is passed only when a processed workflow passed", () => {
    expect(verificationPhase("PROCESSED", "PASSED")).toBe("passed");
  });

  it("is failed for every other processed outcome", () => {
    expect(verificationPhase("PROCESSED", "WARNING")).toBe("failed");
    expect(verificationPhase("PROCESSED", "REJECTED")).toBe("failed");
    expect(verificationPhase("PROCESSED", null)).toBe("failed");
  });

  it("is failed for expired and failed workflows", () => {
    expect(verificationPhase("SESSION_EXPIRED", null)).toBe("failed");
    expect(verificationPhase("TOKEN_EXPIRED", null)).toBe("failed");
    expect(verificationPhase("FAILED", null)).toBe("failed");
  });

  it("is pending while the workflow is still moving", () => {
    expect(verificationPhase("INITIATED", null)).toBe("pending");
    expect(verificationPhase("ACQUISITION_STARTED", null)).toBe("pending");
    expect(verificationPhase("ACQUIRED", null)).toBe("pending");
    expect(verificationPhase("PROCESSING", null)).toBe("pending");
  });
});
