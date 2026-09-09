import { describe, expect, it } from "vitest";

import { mapDocumentWorkflowDetails } from "./document-mapper";

import type { JumioWorkflowDetails } from "./types";

/**
 * The document mapper has a harder job than its identity sibling: supporting
 * documents do not share a shape. So these tests are mostly about what happens
 * when the response is *not* the tidy example — a missing address, a name split
 * one way instead of another, a field nobody anticipated.
 */

/** A passed utility-bill check, shaped as Jumio's Doc Proof examples describe it. */
const PASSED_UTILITY_BILL: JumioWorkflowDetails = {
  workflow: { id: "wf-doc-1", status: "PROCESSED", definitionKey: "10170" },
  account: { id: "acc-1" },
  completedAt: "2026-09-09T11:15:00.000Z",
  decision: { type: "PASSED", details: { label: "PASSED" }, risk: { score: 8 } },
  capabilities: {
    extraction: [
      {
        credentials: [{ id: "cred-1", category: "DOCUMENT" }],
        decision: { type: "PASSED", details: { label: "OK" } },
        data: {
          type: "UB",
          subType: "ELECTRICITY",
          issuer: "Pacific Gas & Electric",
          issuingCountry: "USA",
          issuingDate: "2026-08-02",
          firstName: "John",
          lastName: "Smith",
          address: {
            line1: "1600 Amphitheatre Parkway",
            city: "Mountain View",
            subdivision: "CA",
            postalCode: "94043",
            country: "USA",
            formattedAddress: "1600 Amphitheatre Parkway, Mountain View, CA 94043",
          },
        },
      },
    ],
    usability: [{ decision: { type: "PASSED", details: { label: "OK" } } }],
  },
};

describe("mapDocumentWorkflowDetails", () => {
  it("maps a passed utility bill, address and all", () => {
    const result = mapDocumentWorkflowDetails(PASSED_UTILITY_BILL);

    expect(result.status).toBe("PROCESSED");
    expect(result.decision).toBe("PASSED");
    expect(result.riskScore).toBe(8);
    expect(result.documentType).toBe("UB");
    expect(result.documentSubType).toBe("ELECTRICITY");
    expect(result.issuer).toBe("Pacific Gas & Electric");
    expect(result.name).toBe("John Smith");
    expect(result.addressLine1).toBe("1600 Amphitheatre Parkway");
    expect(result.addressCity).toBe("Mountain View");
    expect(result.addressSubdivision).toBe("CA");
    expect(result.addressPostalCode).toBe("94043");
    expect(result.formattedAddress).toBe("1600 Amphitheatre Parkway, Mountain View, CA 94043");
    expect(result.issuingDate).toEqual(new Date("2026-08-02T00:00:00.000Z"));
    expect(result.completedAt).toEqual(new Date("2026-09-09T11:15:00.000Z"));
  });

  it("keeps the extraction object verbatim, including fields it does not map", () => {
    const result = mapDocumentWorkflowDetails({
      ...PASSED_UTILITY_BILL,
      capabilities: {
        extraction: [
          {
            credentials: [{ category: "DOCUMENT" }],
            data: { type: "BS", accountNumberLast4: "8891", statementPeriod: "2026-07" },
          },
        ],
      },
    });

    // Mapped fields cover what the UI reads; the blob is what stops an
    // unanticipated field from being silently dropped.
    expect(result.documentType).toBe("BS");
    expect(result.extractedData).toEqual({
      type: "BS",
      accountNumberLast4: "8891",
      statementPeriod: "2026-07",
    });
  });

  it("falls back to a whole-name field when the parts are not split", () => {
    const result = mapDocumentWorkflowDetails({
      capabilities: { extraction: [{ data: { name: "Jane Q. Public" } }] },
    });

    expect(result.name).toBe("Jane Q. Public");
  });

  it("uses whichever name part is present rather than showing nothing", () => {
    const result = mapDocumentWorkflowDetails({
      capabilities: { extraction: [{ data: { lastName: "Smith" } }] },
    });

    expect(result.name).toBe("Smith");
  });

  it("selects the DOCUMENT credential's extraction, not merely the first", () => {
    const result = mapDocumentWorkflowDetails({
      capabilities: {
        extraction: [
          { credentials: [{ category: "ID" }], data: { type: "DRIVING_LICENSE" } },
          { credentials: [{ category: "DOCUMENT" }], data: { type: "UB" } },
        ],
      },
    });

    expect(result.documentType).toBe("UB");
  });

  it("falls back to issuingCountry when the address carries no country", () => {
    const result = mapDocumentWorkflowDetails({
      capabilities: {
        extraction: [{ data: { issuingCountry: "GBR", address: { city: "Leeds" } } }],
      },
    });

    expect(result.addressCountry).toBe("GBR");
  });

  it("survives a response with no extraction at all", () => {
    const result = mapDocumentWorkflowDetails({
      workflow: { status: "PROCESSED" },
      decision: { type: "REJECTED", details: { label: "NOT_READABLE" } },
    });

    expect(result.status).toBe("PROCESSED");
    expect(result.decision).toBe("REJECTED");
    expect(result.documentType).toBeNull();
    expect(result.name).toBeNull();
    expect(result.extractedData).toBeNull();
    expect(result.decisionDetails).toEqual({ workflow: "NOT_READABLE" });
  });

  it("collects one capability label per capability, for the detail view", () => {
    const result = mapDocumentWorkflowDetails(PASSED_UTILITY_BILL);

    expect(result.decisionDetails).toEqual({
      extraction: "OK",
      usability: "OK",
      workflow: "PASSED",
    });
  });

  it("does not report -1 as a risk score", () => {
    const result = mapDocumentWorkflowDetails({
      decision: { type: "NOT_EXECUTED", risk: { score: -1 } },
    });

    expect(result.riskScore).toBeNull();
  });

  it("treats an unfinished workflow as processing, never as a failure", () => {
    const result = mapDocumentWorkflowDetails({ workflow: { status: "ACQUIRED" } });

    expect(result.status).toBe("ACQUIRED");
    expect(result.decision).toBeNull();
  });
});
