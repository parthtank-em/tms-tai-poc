import { asAlerts, getAlertTypes, type PublicApiBrokerAlert } from "./api-client";

/**
 * Alert types come from TAI, not from us.
 *
 * `GET /PublicApi/Broker/v2/Alerts` ("Get Shipment Alert Type") returns the
 * org's configured types. `POST /Alerts` takes type *names*, and resolving
 * matches on the name too — so a value we invented could raise an alert that
 * can never be cleared through the API. That is why there is no local fallback
 * list: if TAI cannot tell us the vocabulary, the operator does not get to
 * guess at it.
 */

export type AlertTypeOption = {
  /** `displayName` — used as both the value sent to TAI and the label shown. */
  name: string;
  isManual: boolean | null;
  displayInFrontOffice: boolean | null;
};

/** Guards against blank or absurdly long values before they reach TAI. */
export function normalizeAlertType(value: string): string | null {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 && trimmed.length <= 120 ? trimmed : null;
}

/**
 * Short-lived cache. Alert types are org configuration that changes rarely, and
 * the modal would otherwise re-fetch on every open.
 *
 * Process-local by design: it is a latency cache, never a source of truth, so
 * several server instances each holding their own copy is fine.
 */
const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; options: AlertTypeOption[] } | null = null;

function toOptions(data: unknown): AlertTypeOption[] {
  const seen = new Set<string>();

  return asAlerts(data as PublicApiBrokerAlert[])
    .map((alert) => {
      const raw = (alert as PublicApiBrokerAlert).displayName;
      return {
        name: typeof raw === "string" ? raw.trim() : "",
        isManual: (alert as PublicApiBrokerAlert).isManual ?? null,
        displayInFrontOffice: (alert as PublicApiBrokerAlert).displayInFrontOffice ?? null,
      };
    })
    .filter((option) => {
      if (!option.name || seen.has(option.name.toLowerCase())) return false;
      seen.add(option.name.toLowerCase());
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type AlertTypesResult = { options: AlertTypeOption[]; error: string | null };

export async function loadAlertTypes(options?: { force?: boolean }): Promise<AlertTypesResult> {
  if (!options?.force && cache && Date.now() - cache.at < TTL_MS) {
    return { options: cache.options, error: null };
  }

  // Not tied to a shipment or a queued job — this is a read, so it is not
  // routed through the outbound queue.
  const result = await getAlertTypes({}, { attempt: 1 });

  if (!result.ok) {
    // Serve a stale list rather than blocking the operator, but say nothing
    // false: a fresh failure with no cache returns the error.
    if (cache) return { options: cache.options, error: null };
    return { options: [], error: result.error };
  }

  const parsed = toOptions(result.data);
  cache = { at: Date.now(), options: parsed };

  return { options: parsed, error: null };
}

/**
 * True when the name is one TAI told us about. Used as a server-side backstop
 * for the dropdown; when no list is available it declines to judge, so a TAI
 * outage cannot block an operator from recording an alert locally.
 */
export function isKnownAlertType(name: string): boolean | null {
  if (!cache) return null;
  return cache.options.some((option) => option.name.toLowerCase() === name.toLowerCase());
}
