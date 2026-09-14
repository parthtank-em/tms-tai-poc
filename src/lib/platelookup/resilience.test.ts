import { afterEach, describe, expect, it, vi } from "vitest";

import { lookupVehicle, normalizeVehicle } from "./client";
import sampleResponses from "./sample-responses.json";

/**
 * Two real `/v3/history` responses, captured from the live API.
 *
 * Their envelopes match exactly — `{ success, data, balance }`, and the same
 * eight keys under `data` — but the nested blocks do not: the 2003 Buick
 * carries `mpg_city`/`mpg_highway` and no `fuel_type`, while the 2020 Chevrolet
 * is the reverse, and the Buick has 26 spec fields the Chevrolet omits. Fields
 * appear only when the API has a value for that vehicle.
 *
 * So the page can never assume a field is there. These tests pin that down:
 * every field is optional, and nothing about a missing one throws.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const [chevrolet, buick] = sampleResponses;

function stubFetchJson(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
}

async function lookup(body: unknown) {
  stubFetchJson(body);
  vi.stubEnv("PLATELOOKUP_API_KEY", "test-key");
  return lookupVehicle({ vin: "3GNCJLSBXLL230525", state: "", plate: "" });
}

describe("the two captured responses", () => {
  it("maps the Chevrolet, which has fuel_type but no mpg", async () => {
    const result = await lookup(chevrolet);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.vehicle.make).toBe("CHEVROLET");
    expect(result.vehicle.model).toBe("Trax");
    expect(result.vehicle.year).toBe("2020");
    expect(result.vehicle.fuelType).toBe("Gasoline");
    expect(result.vehicle.bodyType).toBe("Sport Utility Vehicle (SUV)");
  });

  it("maps the Buick, whose vehicle block has no fuel_type at all", async () => {
    const result = await lookup(buick);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.vehicle.make).toBe("BUICK");
    expect(result.vehicle.year).toBe("2003");
    // Absent in this response — it must read as "no value", not throw or
    // surface as the string "undefined".
    expect(result.vehicle.fuelType).toBeNull();
  });

  it("keeps the unmapped sections intact for the raw panel", async () => {
    const result = await lookup(buick);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.raw).toMatchObject({
      recalls: [{ campaign: "02V328000" }],
      owners: [{ index: 1 }, { index: 2 }, { index: 3 }],
    });
    // Whatever the shape, the raw view has to be able to print it.
    expect(() => JSON.stringify(result.raw)).not.toThrow();
  });

  it("returns every mapped field as a string or null, for both vehicles", async () => {
    for (const response of [chevrolet, buick]) {
      const result = await lookup(response);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      for (const [key, value] of Object.entries(result.vehicle)) {
        expect(value === null || typeof value === "string", `${key} was ${typeof value}`).toBe(
          true,
        );
      }
    }
  });
});

describe("payloads with pieces missing", () => {
  it("survives a data object with nothing in it", async () => {
    const result = await lookup({ success: true, data: { VIN: "3GNCJLSBXLL230525" } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vehicle.make).toBeNull();
    expect(result.vehicle.vin).toBe("3GNCJLSBXLL230525");
  });

  it.each([
    ["vehicle is null", { vehicle: null }],
    ["vehicle is an array", { vehicle: [] }],
    ["vehicle is a string", { vehicle: "CHEVROLET" }],
    ["fields are nested objects", { vehicle: { make: { name: "CHEVROLET" } } }],
    ["fields are arrays", { vehicle: { model: ["Trax"] } }],
    ["fields are booleans", { vehicle: { trim: true } }],
    ["fields are explicitly null", { vehicle: { make: null, model: null } }],
    ["sections are objects, not arrays", { vehicle: {}, recalls: {}, owners: {} }],
  ])("does not throw when %s", async (_label, data) => {
    const result = await lookup({ success: true, data: { VIN: "X", ...data } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const value of Object.values(result.vehicle)) {
      expect(value === null || typeof value === "string").toBe(true);
    }
  });

  it("does not throw on a deeply wrong payload", () => {
    expect(() => normalizeVehicle({})).not.toThrow();
    expect(() => normalizeVehicle({ vehicle: 7 })).not.toThrow();
    expect(normalizeVehicle({ vehicle: 7 }).make).toBeNull();
  });
});
