import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Client for TAI's Public REST API (findings §4).
 *
 * Note the credential: this is `x-api-key`, a **different** secret from the
 * inbound webhook `Authorization` header. Two credentials, opposite directions
 * — see §7.
 *
 * Every attempt is written to `tai_api_calls` before the result is returned, so
 * an audit trail exists whether the call succeeded, failed, or never left the
 * building.
 */

const DEFAULT_BASE_URL = "https://www.taicloud.net/PublicApi/Shipping/v2";
const TIMEOUT_MS = 30_000;

export type TaiAlert = {
  type?: string;
  alertId?: number;
  createdDate?: string;
  resolved?: boolean;
  shipmentStopId?: number;
};

export type TaiCallResult =
  | { ok: true; status: number; alerts: TaiAlert[] }
  | { ok: false; status: number | null; error: string; retryable: boolean };

export type AlertRequest = {
  shipmentId: number;
  shipmentAlerts: string[];
};

type CallContext = {
  jobId?: string;
  shipmentId?: string;
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

async function post(
  path: string,
  body: AlertRequest,
  context: CallContext,
): Promise<TaiCallResult> {
  const apiKey = process.env.TAI_API_KEY;
  const endpoint = `${baseUrl()}${path}`;

  const log = async (fields: Omit<Prisma.TaiApiCallUncheckedCreateInput, "endpoint" | "method">) => {
    await prisma.taiApiCall.create({
      data: {
        endpoint,
        method: "POST",
        requestBody: body as unknown as Prisma.InputJsonValue,
        attempt: context.attempt,
        jobId: context.jobId ?? null,
        shipmentId: context.shipmentId ?? null,
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
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
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
      return {
        ok: false,
        status: response.status,
        error,
        retryable: isRetryable(response.status),
      };
    }

    await log({
      responseStatus: response.status,
      responseBody: parsed as Prisma.InputJsonValue,
      durationMs,
    });

    // §4.1 documents an array response; tolerate a single object too.
    const alerts: TaiAlert[] = Array.isArray(parsed)
      ? (parsed as TaiAlert[])
      : parsed && typeof parsed === "object"
        ? [parsed as TaiAlert]
        : [];

    return { ok: true, status: response.status, alerts };
  } catch (cause) {
    const durationMs = Date.now() - startedAt;
    const error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    await log({ error, durationMs });
    return { ok: false, status: null, error, retryable: true };
  }
}

/** `POST /Alerts` — raise one or more alerts against a shipment. */
export function createAlerts(body: AlertRequest, context: CallContext): Promise<TaiCallResult> {
  return post("/Alerts", body, context);
}

/** `POST /Alerts/Resolved` — clear one or more alerts on a shipment. */
export function resolveAlerts(body: AlertRequest, context: CallContext): Promise<TaiCallResult> {
  return post("/Alerts/Resolved", body, context);
}

export function isTaiConfigured(): boolean {
  return Boolean(process.env.TAI_API_KEY);
}
