import { asBrokerStaff, getBrokerStaff, type PublicApiBrokerStaff } from "./api-client";

import { formatLocation } from "@/lib/format";

/**
 * Broker staff come from TAI, not from us.
 *
 * `GET /PublicApi/Staff/v2/Brokers` returns the org's roster, and
 * `POST /Assignments` takes a `staffId` from it. There is no local fallback
 * list for the same reason alert types have none: an id we invented would name
 * nobody, and the assignment would either fail or attach to the wrong person.
 *
 * Two readings of the same endpoint live here:
 *
 * - `loadBrokerStaff` — the assignment dropdown. Assignable people only, cached,
 *   shaped as options. Same as `alert-types.ts`: org configuration behind a
 *   picker.
 * - `listBrokerStaff` — the `/tai/staff` table. Everyone TAI returns, uncached,
 *   with the contact fields the page shows. A roster page that hid disabled
 *   accounts or served a five-minute-old copy would be answering a different
 *   question than the one it appears to answer.
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

// --- The roster as a table -------------------------------------------------

/**
 * One person, as `/tai/staff` shows them. Every field but the id is nullable:
 * the spec marks nothing required beyond what identifies the row, so a sparse
 * record renders as gaps rather than as empty strings.
 */
export type StaffMember = {
  staffId: number;
  /** `contactName`, or the identifier they are otherwise known by. */
  name: string;
  title: string | null;
  email: string | null;
  login: string | null;
  /** `phone`, falling back to `mobile` — the table has one column for reaching them. */
  phone: string | null;
  location: string | null;
  organizationId: number | null;
  /** `undefined` from TAI reads as unknown, not as disabled. */
  enabled: boolean | null;
};

export type StaffDirectoryResult = { staff: StaffMember[]; error: string | null };

/** Trims, and turns blank into `null` so the table's own dash rendering applies. */
function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * `formatLocation` renders its own dash for an empty address; here an empty one
 * has to read as `null` so every gap in the row is spelled the same way.
 */
function toLocation(address: PublicApiBrokerStaff["address"]): string | null {
  if (!address) return null;

  const location = formatLocation({
    city: text(address.city),
    state: text(address.state),
    postalCode: text(address.zipCode),
  });

  return location === "—" ? null : location;
}

function toMember(staff: PublicApiBrokerStaff): StaffMember {
  const name = toLabel(staff);

  return {
    staffId: staff.staffId as number,
    name,
    // A title that merely repeats the name says nothing twice.
    title: text(staff.title) === name ? null : text(staff.title),
    email: text(staff.email),
    login: text(staff.login),
    phone: text(staff.phone) ?? text(staff.mobile),
    location: toLocation(staff.address),
    organizationId: typeof staff.organizationId === "number" ? staff.organizationId : null,
    enabled: typeof staff.enabled === "boolean" ? staff.enabled : null,
  };
}

/**
 * The whole roster, read straight from TAI on every request.
 *
 * Unlike `loadBrokerStaff` this keeps people whose account is disabled: the
 * page is a directory, and an account that exists but cannot sign in is
 * something the table says rather than something it hides. Rows without a
 * `staffId` still go — that id is how a person is addressed everywhere else, so
 * a row lacking one names nobody the operator could act on.
 */
export async function listBrokerStaff(): Promise<StaffDirectoryResult> {
  const result = await getBrokerStaff({}, { attempt: 1 });

  if (!result.ok) {
    // The raw TAI error stays in `tai_api_calls`; the page gets the outcome.
    return { staff: [], error: "Could not load staff from TAI." };
  }

  const seen = new Set<number>();

  const staff = asBrokerStaff(result.data)
    .filter((entry) => {
      if (typeof entry.staffId !== "number" || !Number.isInteger(entry.staffId)) return false;
      if (entry.staffId < 1) return false;
      // TAI has been seen returning a row more than once (see the note in
      // `reference-numbers.ts`); the id is unique, so the first wins.
      if (seen.has(entry.staffId)) return false;

      seen.add(entry.staffId);
      return true;
    })
    .map(toMember)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { staff, error: null };
}
