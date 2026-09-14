/**
 * Client for the PlateLookup API — `GET /v3/history`.
 *
 * Transcribed from `docs/platelookup - API.pdf` (the Swagger UI for
 * https://api.platelookup.app/v3/docs), cross-checked against the live service.
 *
 * This POC is self-contained: one endpoint, no database. The lookup is fetched
 * and rendered, and that is the whole flow.
 */

const BASE_URL = "https://api.platelookup.app/v3";

const TIMEOUT_MS = 20_000;

/** VINs exclude I, O and Q so they cannot be confused with 1 and 0. */
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/i;

const STATE_PATTERN = /^[A-Za-z]{2}$/;

// --- Response shape --------------------------------------------------------

/**
 * The `data.vehicle` block, flattened.
 *
 * Every field is nullable: the documented example carries a full vehicle, but
 * the API fills in what it has, and a decode that half-succeeds still returns
 * 200. Anything not mapped here stays visible in the raw response panel.
 */
export type PlateLookupVehicle = {
  vin: string | null;
  make: string | null;
  model: string | null;
  year: string | null;
  trim: string | null;
  bodyType: string | null;
  engine: string | null;
  drivetrain: string | null;
  cylinders: string | null;
  fuelType: string | null;
  seatingCapacity: string | null;
  baseMsrp: string | null;
  manufacturedIn: string | null;
};

export type PlateLookupFailure =
  /** No API key configured — see .env.example. */
  | "unconfigured"
  /** The form did not identify a vehicle, so no call was made. */
  | "invalid-query"
  /** 401 — the key was missing or rejected. */
  | "unauthorized"
  /** 400 — the API rejected the query parameters. */
  | "bad-request"
  /** 404, or a 200 carrying no vehicle. */
  | "not-found"
  /** 5xx, or a body that did not parse. */
  | "upstream"
  /** DNS, TLS, timeout — the request never produced a response. */
  | "network";

export type PlateLookupResult =
  | {
      ok: true;
      vehicle: PlateLookupVehicle;
      /**
       * The `data` object exactly as returned. `/v3/history` also carries
       * owners, titles, accidents, auctions and recalls; the API PDF names
       * those DTOs without giving their fields, so they reach the page through
       * the raw view rather than a mapping built on guesses.
       */
      raw: unknown;
    }
  | { ok: false; failure: PlateLookupFailure; message: string };

/** What the form collects. Any field may be blank; `buildQuery` decides. */
export type PlateLookupQuery = {
  vin: string;
  state: string;
  plate: string;
};

// --- Parsing ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(source: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    // The API uses "-" for a spec it has no value for; that is a blank, not
    // something to print.
    return trimmed === "" || trimmed === "-" ? null : trimmed;
  }
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * A successful call wraps the payload as `{ success: true, data: {...} }`. The
 * schema example in the docs shows the inner object on its own, so both are
 * unwrapped rather than letting the envelope decide whether the POC works.
 */
function extractData(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;

  if (isRecord(body.data)) return body.data;

  // No envelope, but it looks like the payload itself.
  return "VIN" in body || "vehicle" in body ? body : null;
}

export function normalizeVehicle(data: Record<string, unknown>): PlateLookupVehicle {
  const vehicle = isRecord(data.vehicle) ? data.vehicle : {};

  return {
    vin: asString(pick(data, "VIN", "vin")),
    make: asString(pick(vehicle, "make")),
    model: asString(pick(vehicle, "model")),
    year: asString(pick(vehicle, "year")),
    trim: asString(pick(vehicle, "trim")),
    bodyType: asString(pick(vehicle, "body_type")),
    engine: asString(pick(vehicle, "engine")),
    drivetrain: asString(pick(vehicle, "drivetrain")),
    cylinders: asString(pick(vehicle, "cylinders")),
    fuelType: asString(pick(vehicle, "fuel_type")),
    seatingCapacity: asString(pick(vehicle, "seating_capacity")),
    baseMsrp: asString(pick(vehicle, "base_msrp")),
    manufacturedIn: asString(pick(vehicle, "manufactured_in")),
  };
}

// --- Query -----------------------------------------------------------------

export type BuiltQuery =
  | { ok: true; params: URLSearchParams }
  | { ok: false; message: string };

/**
 * Turns the form into query parameters.
 *
 * The endpoint identifies a vehicle "by VIN or license plate", and the docs
 * mark `state` as required alongside `plate`. Both routes are allowed here, and
 * anything that identifies nothing is refused before a call is spent.
 */
export function buildQuery({ vin, state, plate }: PlateLookupQuery): BuiltQuery {
  const cleanVin = vin.trim().toUpperCase();
  const cleanState = state.trim().toUpperCase();
  const cleanPlate = plate.trim().toUpperCase();

  const params = new URLSearchParams();

  if (cleanVin) {
    if (!VIN_PATTERN.test(cleanVin)) {
      return { ok: false, message: "A VIN is 17 characters, letters and digits, with no I, O or Q." };
    }
    params.set("vin", cleanVin);
  }

  if (cleanPlate) {
    if (!cleanState) {
      return { ok: false, message: "A plate needs the state it was issued in." };
    }
    if (!STATE_PATTERN.test(cleanState)) {
      return { ok: false, message: "State must be a 2-letter code, such as VA." };
    }
    params.set("state", cleanState);
    params.set("plate", cleanPlate);
  } else if (cleanState && !cleanVin) {
    return { ok: false, message: "Enter the plate number to go with the state." };
  }

  if (!params.has("vin") && !params.has("plate")) {
    return { ok: false, message: "Enter a VIN, or a state and plate." };
  }

  return { ok: true, params };
}

// --- Lookup ----------------------------------------------------------------

/**
 * Looks up one vehicle's history.
 *
 * The key is read here, server-side. It travels in a header rather than the
 * URL, but it is still a credential the browser has no business holding.
 */
export async function lookupVehicle(query: PlateLookupQuery): Promise<PlateLookupResult> {
  const built = buildQuery(query);

  if (!built.ok) {
    return { ok: false, failure: "invalid-query", message: built.message };
  }

  const apiKey = process.env.PLATELOOKUP_API_KEY?.trim();

  if (!apiKey) {
    return {
      ok: false,
      failure: "unconfigured",
      message: "PLATELOOKUP_API_KEY is not set. See .env.example.",
    };
  }

  const url = `${BASE_URL}/history?${built.params.toString()}`;

  let response: Response;

  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "X-API-Key": apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return {
      ok: false,
      failure: "network",
      message: "Could not reach PlateLookup. Check the connection and try again.",
    };
  }

  let body: unknown = null;

  try {
    body = await response.json();
  } catch {
    body = null;
  }

  /** The API's error envelope is `{ message, error, statusCode }`. */
  const apiMessage = isRecord(body) ? asString(body.message) : null;

  if (response.status === 401) {
    return { ok: false, failure: "unauthorized", message: "PlateLookup rejected the API key." };
  }

  if (response.status === 400) {
    // This message is about the query parameters, so it is safe to show as-is.
    return {
      ok: false,
      failure: "bad-request",
      message: apiMessage ?? "PlateLookup rejected the query parameters.",
    };
  }

  if (response.status === 404) {
    return { ok: false, failure: "not-found", message: "No vehicle found for that lookup." };
  }

  if (!response.ok) {
    return {
      ok: false,
      failure: "upstream",
      message: `PlateLookup returned ${response.status}. Try again shortly.`,
    };
  }

  const data = extractData(body);

  if (!data) {
    return { ok: false, failure: "not-found", message: "No vehicle found for that lookup." };
  }

  return { ok: true, vehicle: normalizeVehicle(data), raw: data };
}
