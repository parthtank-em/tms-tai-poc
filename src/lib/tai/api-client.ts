import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Client for TAI's Public REST API — BrokerTMS V2.
 *
 * The alert endpoints below are transcribed from TAI's published OpenAPI
 * definition; the schema names in the doc comments are the spec's own, so a
 * future diff against their docs is a straight comparison.
 *
 * Note the credential: `x-api-key`, a **different** secret from the inbound
 * webhook `Authorization` header. Two credentials, opposite directions (§7).
 *
 * Every attempt is written to `tai_api_calls` before the result is returned, so
 * an audit trail exists whether the call succeeded, failed, or never left the
 * building.
 */

/**
 * The `servers` entry in TAI's OpenAPI definition.
 *
 * ⚠️ This is the **beta** host. The findings doc §4 names
 * `https://www.taicloud.net` instead — same API, different environment. Set
 * `TAI_API_BASE_URL` to switch; it is the host only, with no path.
 */
const DEFAULT_BASE_URL = "https://www.taibeta.net";

const SHIPPING_PREFIX = "/PublicApi/Shipping/v2";
/** Alert *types* are org configuration, so they live under Broker, not Shipping. */
const BROKER_PREFIX = "/PublicApi/Broker/v2";

/** Paths exactly as the OpenAPI definitions declare them. */
const PATHS = {
  alerts: `${SHIPPING_PREFIX}/Alerts`,
  alertsResolved: `${SHIPPING_PREFIX}/Alerts/Resolved`,
  brokerAlertTypes: `${BROKER_PREFIX}/Alerts`,
  // Use case 3 (§4.2). Not covered by the pasted OpenAPI definition, so these
  // are still inferred from the findings doc rather than verified.
  tracking: `${SHIPPING_PREFIX}/Tracking`,
  activityLogs: `${SHIPPING_PREFIX}/ShipmentActivityLogs`,
} as const;

const TIMEOUT_MS = 30_000;

/** `shipmentId` is an int32 with minimum 1 per the spec. */
const INT32_MAX = 2_147_483_647;

export function isValidTaiShipmentId(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= INT32_MAX;
}

// --- Spec schemas ----------------------------------------------------------

/** `TMSFoundation.Models.PublicAPI.v2.PublicAPIShipmentAlert` */
export type PublicApiShipmentAlert = {
  type?: string;
  /** int32 */
  alertId?: number;
  /** date-time */
  createdDate?: string;
  resolved?: boolean;
  /** int32 — returned by TAI, not accepted in the request (§9). */
  shipmentStopId?: number;
};

/**
 * `TMSFoundation.Models.PublicAPI.v2.Alerts.PublicAPIAddShipmentAlert`
 * Both fields are required.
 */
export type PublicApiAddShipmentAlert = {
  /** int32, 1 … 2147483647 */
  shipmentId: number;
  shipmentAlerts: string[];
};

/**
 * `TMSFoundation.Models.PublicAPI.v2.Alerts.PublicAPIResolveShipmentAlert`
 * A distinct schema in the spec, structurally identical to the add request.
 */
export type PublicApiResolveShipmentAlert = PublicApiAddShipmentAlert;

// --- Transport -------------------------------------------------------------

export type TaiCallResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number | null; error: string; retryable: boolean };

export type CallContext = {
  jobId?: string;
  shipmentId?: string;
  eventId?: string;
  attempt: number;
};

function baseUrl(): string {
  return (process.env.TAI_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * 4xx means the request itself is wrong — retrying sends the same bad request
 * again. 408/429 are the exceptions, and everything at 5xx or below the HTTP
 * layer (DNS, TLS, timeout) is worth another go.
 */
function isRetryable(status: number | null): boolean {
  if (status === null) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

async function call(
  method: "GET" | "POST" | "PUT",
  path: string,
  body: unknown,
  context: CallContext,
): Promise<TaiCallResult> {
  const apiKey = process.env.TAI_API_KEY;
  const endpoint = `${baseUrl()}${path}`;

  const log = async (
    fields: Omit<Prisma.TaiApiCallUncheckedCreateInput, "endpoint" | "method">,
  ) => {
    await prisma.taiApiCall.create({
      data: {
        endpoint,
        method,
        requestBody: (body ?? null) as Prisma.InputJsonValue,
        attempt: context.attempt,
        jobId: context.jobId ?? null,
        shipmentId: context.shipmentId ?? null,
        eventId: context.eventId ?? null,
        ...fields,
      },
    });
  };

  if (!apiKey) {
    // Not retryable: no amount of waiting produces a credential.
    const error = "TAI_API_KEY is not set — cannot call the TAI Public API.";
    await log({ error });
    return { ok: false, status: null, error, retryable: false };
  }

  const startedAt = Date.now();

  try {
    const response = await fetch(endpoint, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        "x-api-key": apiKey,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const durationMs = Date.now() - startedAt;
    const text = await response.text();

    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { _unparsed: text.slice(0, 4000) };
    }

    if (!response.ok) {
      const error = `TAI responded ${response.status}: ${text.slice(0, 500)}`;
      await log({
        responseStatus: response.status,
        responseBody: parsed as Prisma.InputJsonValue,
        error,
        durationMs,
      });
      return { ok: false, status: response.status, error, retryable: isRetryable(response.status) };
    }

    await log({
      responseStatus: response.status,
      responseBody: parsed as Prisma.InputJsonValue,
      durationMs,
    });

    return { ok: true, status: response.status, data: parsed };
  } catch (cause) {
    const durationMs = Date.now() - startedAt;
    const error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    await log({ error, durationMs });
    return { ok: false, status: null, error, retryable: true };
  }
}

/** Rejects a request the spec would reject, without spending an HTTP round trip. */
function validateAlertRequest(body: PublicApiAddShipmentAlert): string | null {
  if (!isValidTaiShipmentId(body.shipmentId)) {
    return `shipmentId must be an int32 between 1 and ${INT32_MAX}; got ${String(body.shipmentId)}.`;
  }
  if (!Array.isArray(body.shipmentAlerts) || body.shipmentAlerts.length === 0) {
    return "shipmentAlerts must contain at least one alert type.";
  }
  return null;
}

// --- Use case 4: security alerts -------------------------------------------

/**
 * **Create Shipment Alert** — `POST /PublicApi/Shipping/v2/Alerts`
 * "Add a new shipment alert by shipment id."
 * operationId `PublicAPIShipping_AddAlerts`
 *
 * Responds 200 with an array of `PublicAPIShipmentAlert`.
 */
export async function createAlerts(
  body: PublicApiAddShipmentAlert,
  context: CallContext,
): Promise<TaiCallResult> {
  const invalid = validateAlertRequest(body);
  if (invalid) {
    return { ok: false, status: null, error: invalid, retryable: false };
  }

  return call("POST", PATHS.alerts, body, context);
}

/**
 * **Update Shipment Alert** — `POST /PublicApi/Shipping/v2/Alerts/Resolved`
 * "Resolve an existing shipment alert by shipment id and alert type."
 * operationId `PublicAPIShipping_ResolveAlerts`
 *
 * Responds 200 with an array of `PublicAPIShipmentAlert`.
 */
export async function resolveAlerts(
  body: PublicApiResolveShipmentAlert,
  context: CallContext,
): Promise<TaiCallResult> {
  const invalid = validateAlertRequest(body);
  if (invalid) {
    return { ok: false, status: null, error: invalid, retryable: false };
  }

  return call("POST", PATHS.alertsResolved, body, context);
}

/**
 * `TMSFoundation.Models.PublicAPI.v2.Customer.PublicAPIBrokerAlert`
 *
 * ⚠️ Two different things are called `alertId` in this API. Here it identifies
 * an alert **type** (org configuration). On `PublicAPIShipmentAlert` it
 * identifies a **raised alert** on one shipment — that is the one stored in
 * `shipment_alerts.tai_alert_id`. They are not interchangeable.
 *
 * `POST /Alerts` takes type *names* (`shipmentAlerts: string[]`), not type ids,
 * so `displayName` is the field that matters for raising an alert.
 */
export type PublicApiBrokerAlert = {
  isManual?: boolean;
  displayInFrontOffice?: boolean;
  /** int32 — the alert TYPE id. */
  alertId?: number;
  displayName?: string;
};

/**
 * **Get Shipment Alert Type** — `GET /PublicApi/Broker/v2/Alerts`
 * "Find existing shipment alert types."
 * operationId `PublicAPIBroker_GetAlerts`
 *
 * Responds 200 with an array of `PublicAPIBrokerAlert`, or 400 with a string.
 *
 * Both query parameters are optional and are left unset by default, so the
 * caller sees every configured type rather than a silently narrowed list.
 * `isManual` is the likely refinement for an operator-raised alert once TAI
 * confirms what it means.
 */
export function getAlertTypes(
  filters: { isManual?: boolean; displayInFrontOffice?: boolean },
  context: CallContext,
): Promise<TaiCallResult> {
  const query = new URLSearchParams();
  if (filters.isManual !== undefined) query.set("isManual", String(filters.isManual));
  if (filters.displayInFrontOffice !== undefined) {
    query.set("displayInFrontOffice", String(filters.displayInFrontOffice));
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return call("GET", `${PATHS.brokerAlertTypes}${suffix}`, undefined, context);
}

/** The spec declares an array response; tolerate a single object defensively. */
export function asAlerts(data: unknown): PublicApiShipmentAlert[] {
  if (Array.isArray(data)) return data as PublicApiShipmentAlert[];
  return data && typeof data === "object" ? [data as PublicApiShipmentAlert] : [];
}

// --- Use case 3: lifecycle sync (§4.2, not in the pasted spec) -------------

/** `PUT /Tracking` — shipment-level status and POD timestamps. */
export function updateTracking(body: unknown, context: CallContext) {
  return call("PUT", PATHS.tracking, body, context);
}

/**
 * `PUT /Tracking/{shipmentStopId}` — arrival/departure and POD signature for
 * one specific stop. Used for multi-stop shipments where the event must attach
 * to the correct stop rather than the shipment as a whole (§4.2).
 */
export function updateStopTracking(shipmentStopId: number, body: unknown, context: CallContext) {
  return call("PUT", `${PATHS.tracking}/${shipmentStopId}`, body, context);
}

/** `POST /ShipmentActivityLogs` — free-text lifecycle note (§4.2). */
export function createActivityLog(body: unknown, context: CallContext) {
  return call("POST", PATHS.activityLogs, body, context);
}

export function isTaiConfigured(): boolean {
  return Boolean(process.env.TAI_API_KEY);
}
