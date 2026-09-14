/**
 * Client for the FMCSA QCMobile API.
 *
 * Transcribed from the vendor docs kept alongside this repo — see
 * `docs/fmcsa - qcAPI.pdf` (endpoints, error codes), `docs/fmcsa - apiAccess.pdf`
 * (the webKey) and `docs/fmcsa - apiElements.pdf` (element names). The public
 * doc pages at https://mobile.fmcsa.dot.gov/QCDevsite/docs/ block automated
 * fetches, which is why the PDFs are the reference of record.
 *
 * This POC is self-contained: one endpoint, `/carriers/:dotNumber`, and no
 * database. The lookup is fetched and rendered, and that is the whole flow.
 */

/** Every resource is under this prefix, per the API URL section of the docs. */
const BASE_URL = "https://mobile.fmcsa.dot.gov/qc/services";

const TIMEOUT_MS = 15_000;

/** USDOT numbers are plain integers; the longest in circulation are 8 digits. */
const DOT_NUMBER_PATTERN = /^\d{1,8}$/;

// --- Response shape --------------------------------------------------------

/**
 * The documented carrier elements.
 *
 * Every field is nullable on purpose. The docs are explicit that "elements only
 * appear if they have value", so a carrier with no complaints simply has no
 * `complaintCount` key rather than a zero — absence is normal, not an error.
 */
export type FmcsaCarrier = {
  dotNumber: number | null;
  mcNumber: string | null;
  legalName: string | null;
  dbaName: string | null;
  /** "Y" or "N" — whether the carrier is allowed to operate by law. */
  allowToOperate: string | null;
  /** "Y" or "N" — whether an out-of-service order is in force. */
  outOfService: string | null;
  outOfServiceDate: string | null;
  complaintCount: number | null;
  busVehicle: number | null;
  limoVehicle: number | null;
  miniBusVehicle: number | null;
  motorCoachVehicle: number | null;
  vanVehicle: number | null;
  passengerVehicle: number | null;
  phyStreet: string | null;
  phyCity: string | null;
  phyState: string | null;
  phyZip: string | null;
  phyCountry: string | null;
  telephone: string | null;
};

export type FmcsaLookupFailure =
  /** No webKey configured — see .env.example. */
  | "unconfigured"
  /** The input was not a USDOT number, so no call was made. */
  | "invalid-dot"
  /** 401 — the webKey was rejected. */
  | "unauthorized"
  /** 404, or a 200 carrying no carrier. */
  | "not-found"
  /** 400/500, or a body that did not parse. */
  | "upstream"
  /** DNS, TLS, timeout — the request never produced a response. */
  | "network";

export type FmcsaLookupResult =
  | {
      ok: true;
      carrier: FmcsaCarrier;
      /** The carrier object exactly as returned, for the raw JSON view. */
      raw: unknown;
      retrievalDate: string | null;
    }
  | { ok: false; failure: FmcsaLookupFailure; message: string };

// --- Parsing ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First key that actually carries a value, so an absent element stays null. */
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
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * `/carriers/:dotNumber` wraps the carrier as `{ content: { carrier } }`. The
 * name search returns `content` as an array instead, and some responses hand
 * the carrier back unwrapped, so all three shapes are unwrapped here rather
 * than letting the envelope decide whether the POC works.
 */
function extractCarrier(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;

  const content = body.content;

  if (Array.isArray(content)) {
    const first = content[0];
    if (!isRecord(first)) return null;
    return isRecord(first.carrier) ? first.carrier : first;
  }

  if (isRecord(content)) {
    return isRecord(content.carrier) ? content.carrier : content;
  }

  return isRecord(body.carrier) ? body.carrier : null;
}

/**
 * Maps the raw carrier onto the documented element names.
 *
 * A few elements are spelled one way in `apiElements.pdf` and another in live
 * responses (`allowToOperate` / `allowedToOperate`, `phyZip` / `phyZipcode`),
 * so both spellings are accepted. Anything not mapped here is still visible in
 * the raw JSON the page renders alongside the summary.
 */
export function normalizeCarrier(raw: Record<string, unknown>): FmcsaCarrier {
  return {
    dotNumber: asNumber(pick(raw, "dotNumber")),
    mcNumber: asString(pick(raw, "mcNumber")),
    legalName: asString(pick(raw, "legalName")),
    dbaName: asString(pick(raw, "dbaName")),
    allowToOperate: asString(pick(raw, "allowToOperate", "allowedToOperate")),
    outOfService: asString(pick(raw, "outOfService", "oosStatus")),
    outOfServiceDate: asString(pick(raw, "outOfServiceDate", "oosDate")),
    complaintCount: asNumber(pick(raw, "complaintCount")),
    busVehicle: asNumber(pick(raw, "busVehicle")),
    limoVehicle: asNumber(pick(raw, "limoVehicle")),
    miniBusVehicle: asNumber(pick(raw, "miniBusVehicle")),
    motorCoachVehicle: asNumber(pick(raw, "motorCoachVehicle")),
    vanVehicle: asNumber(pick(raw, "vanVehicle")),
    passengerVehicle: asNumber(pick(raw, "passengerVehicle")),
    phyStreet: asString(pick(raw, "phyStreet")),
    phyCity: asString(pick(raw, "phyCity")),
    phyState: asString(pick(raw, "phyState")),
    phyZip: asString(pick(raw, "phyZip", "phyZipcode")),
    phyCountry: asString(pick(raw, "phyCountry")),
    telephone: asString(pick(raw, "telephone")),
  };
}

/** Trims, drops leading zeros, and confirms the result is a USDOT number. */
export function normalizeDotNumber(input: string): string | null {
  const digits = input.trim().replace(/^0+(?=\d)/, "");
  return DOT_NUMBER_PATTERN.test(digits) ? digits : null;
}

// --- Lookup ----------------------------------------------------------------

/**
 * Looks up one carrier by USDOT number.
 *
 * The webKey is read here, server-side, and never reaches the browser — it is a
 * query parameter, so a fetch from the client would put it in the address bar
 * and in every proxy log along the way.
 */
export async function lookupCarrier(dotNumberInput: string): Promise<FmcsaLookupResult> {
  const dotNumber = normalizeDotNumber(dotNumberInput);

  if (!dotNumber) {
    return {
      ok: false,
      failure: "invalid-dot",
      message: "Enter a USDOT number — digits only, up to 8 of them.",
    };
  }

  const webKey = process.env.FMCSA_WEB_KEY?.trim();

  if (!webKey) {
    return {
      ok: false,
      failure: "unconfigured",
      message: "FMCSA_WEB_KEY is not set. See .env.example.",
    };
  }

  const url = new URL(`${BASE_URL}/carriers/${dotNumber}`);
  url.searchParams.set("webKey", webKey);

  let response: Response;

  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    // The caught error is deliberately not echoed into the message: fetch puts
    // the full URL in it, and the URL carries the webKey.
    return {
      ok: false,
      failure: "network",
      message: "Could not reach FMCSA. Check the connection and try again.",
    };
  }

  if (response.status === 401) {
    return { ok: false, failure: "unauthorized", message: "FMCSA rejected the webKey." };
  }

  if (response.status === 404) {
    return { ok: false, failure: "not-found", message: `No carrier found for USDOT ${dotNumber}.` };
  }

  if (!response.ok) {
    return {
      ok: false,
      failure: "upstream",
      message: `FMCSA returned ${response.status}. Try again shortly.`,
    };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      failure: "upstream",
      message: "FMCSA returned a response that was not JSON.",
    };
  }

  const raw = extractCarrier(body);

  // A DOT number with no match comes back 200 with an empty `content`, so this
  // is an ordinary miss rather than a malformed response.
  if (!raw) {
    return { ok: false, failure: "not-found", message: `No carrier found for USDOT ${dotNumber}.` };
  }

  return {
    ok: true,
    carrier: normalizeCarrier(raw),
    raw,
    retrievalDate: isRecord(body) ? asString(body.retrievalDate) : null,
  };
}
