import { asBrokerStaff, getBrokerStaff, type PublicApiBrokerStaff } from "./api-client";

/**
 * Broker staff come from TAI, not from us.
 *
 * `GET /PublicApi/Staff/v2/Brokers` returns the org's roster, and
 * `POST /Assignments` takes a `staffId` from it. There is no local fallback
 * list for the same reason alert types have none: an id we invented would name
 * nobody, and the assignment would either fail or attach to the wrong person.
 *
 * This is the same shape as `alert-types.ts`, deliberately — both are org
 * configuration read from TAI to populate a dropdown.
 */

export type StaffOption = {
  /** `staffId` — the value sent to TAI. */
  id: number;
  /** What the operator picks by: a name where TAI has one, else login/email. */
  label: string;
  /** Shown beneath the name to tell two people with the same name apart. */
  detail: string | null;
};

/**
 * Builds the label. `contactName` is the human name, but it is optional in the
 * schema, so fall back through the identifiers a person is otherwise known by
 * rather than render an anonymous row.
 */
function toLabel(staff: PublicApiBrokerStaff): string {
  const candidates = [staff.contactName, staff.login, staff.email];
  const found = candidates.find((value) => typeof value === "string" && value.trim().length > 0);
  return found?.trim() ?? `Staff #${staff.staffId}`;
}

/** Title and email disambiguate a roster where names repeat. */
function toDetail(staff: PublicApiBrokerStaff, label: string): string | null {
  const parts = [staff.title, staff.email]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0 && value !== label);

  return parts.length > 0 ? parts.join(" · ") : null;
}

function toOptions(data: unknown): StaffOption[] {
  const seen = new Set<number>();

  return asBrokerStaff(data)
    .filter((staff) => {
      // A staff id is the whole point of the row; without one it cannot be
      // assigned. `enabled === false` is an explicit "no"; `undefined` is not,
      // so an absent flag is not treated as one.
      if (typeof staff.staffId !== "number" || !Number.isInteger(staff.staffId)) return false;
      if (staff.staffId < 1) return false;
      if (staff.enabled === false) return false;
      if (seen.has(staff.staffId)) return false;

      seen.add(staff.staffId);
      return true;
    })
    .map((staff) => {
      const label = toLabel(staff);
      return { id: staff.staffId as number, label, detail: toDetail(staff, label) };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Short-lived cache, for the same reason `alert-types.ts` has one: a roster
 * changes rarely and the modal would otherwise re-fetch on every open.
 *
 * Process-local by design — a latency cache, never a source of truth.
 */
const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; options: StaffOption[] } | null = null;

export type StaffResult = { options: StaffOption[]; error: string | null };

export async function loadBrokerStaff(options?: { force?: boolean }): Promise<StaffResult> {
  if (!options?.force && cache && Date.now() - cache.at < TTL_MS) {
    return { options: cache.options, error: null };
  }

  // A read, so it does not go through the outbound queue.
  const result = await getBrokerStaff({}, { attempt: 1 });

  if (!result.ok) {
    // Serve a stale roster rather than block the operator, but say nothing
    // false: a fresh failure with no cache returns the error.
    if (cache) return { options: cache.options, error: null };
    return { options: [], error: "Could not load staff from TAI." };
  }

  const parsed = toOptions(result.data);
  cache = { at: Date.now(), options: parsed };

  return { options: parsed, error: null };
}

/**
 * True when the id is one TAI told us about. A server-side backstop for the
 * dropdown; with no cached roster it declines to judge, so a TAI outage cannot
 * block an assignment the operator is entitled to make.
 */
export function isKnownStaffId(staffId: number): boolean | null {
  if (!cache) return null;
  return cache.options.some((option) => option.id === staffId);
}
