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
function toOptionDetail(staff: PublicApiBrokerStaff, label: string): string | null {
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
      return { id: staff.staffId as number, label, detail: toOptionDetail(staff, label) };
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

// --- One person, in full ---------------------------------------------------

/**
 * One staff member, as `/tai/staff/<id>` shows them: the fields the create form
 * sends, read back **one for one**.
 *
 * Deliberately not built on `StaffMember`. The table merges — `phone` falls
 * back to `mobile`, the address collapses to a city line, a `title` matching the
 * name is dropped — because a column can only say one thing. On a detail page
 * those merges lie: a Phone row showing a mobile number, or an address whose
 * parts cannot be told apart, is worse than an empty row. Every field here is
 * the raw value TAI returned, and `null` means TAI sent nothing.
 *
 * Narrower than the response schema on purpose. TAI also returns the seven
 * notification flags, `defaultShipmentType`, `staffSettings` and
 * `tariffSettings`; the form sets none of them, so this does not claim to show
 * them. `PublicApiBrokerStaff` still types them — mirroring the spec is a
 * different job from deciding what a page displays.
 */
export type StaffDetail = {
  staffId: number;
  /** Heading only. The card shows `contactName`, `login` and `email` separately. */
  headingName: string;
  contactName: string | null;
  login: string | null;
  email: string | null;
  title: string | null;
  referenceNumber: string | null;
  organizationId: number | null;
  enabled: boolean | null;
  phone: string | null;
  mobile: string | null;
  fax: string | null;
  address: {
    streetAddress: string | null;
    streetAddressTwo: string | null;
    city: string | null;
    state: string | null;
    zipCode: string | null;
    country: string | null;
    contactName: string | null;
  };
  permissions: string[];
};

function toStaffDetail(staff: PublicApiBrokerStaff): StaffDetail {
  return {
    staffId: staff.staffId as number,
    headingName: toLabel(staff),
    contactName: text(staff.contactName),
    login: text(staff.login),
    email: text(staff.email),
    title: text(staff.title),
    referenceNumber: text(staff.referenceNumber),
    organizationId: typeof staff.organizationId === "number" ? staff.organizationId : null,
    enabled: typeof staff.enabled === "boolean" ? staff.enabled : null,
    phone: text(staff.phone),
    mobile: text(staff.mobile),
    fax: text(staff.fax),
    address: {
      streetAddress: text(staff.address?.streetAddress),
      streetAddressTwo: text(staff.address?.streetAddressTwo),
      city: text(staff.address?.city),
      state: text(staff.address?.state),
      zipCode: text(staff.address?.zipCode),
      country: text(staff.address?.country),
      contactName: text(staff.address?.contactName),
    },
    permissions: [...(staff.permissions ?? [])],
  };
}

export type StaffDetailResult = { staff: StaffDetail | null; error: string | null };

/**
 * Reads one person through the same `GET /Staff/v2/Brokers` the roster uses,
 * narrowed by its `staffId` filter.
 *
 * TAI still answers with an array, and has been seen returning a row more than
 * once, so the response is matched on the id rather than trusted to hold
 * exactly one element. A filter TAI ignored would otherwise hand back the whole
 * roster and the page would render whoever happened to be first.
 */
export async function getStaffMember(staffId: number): Promise<StaffDetailResult> {
  if (!Number.isInteger(staffId) || staffId < 1) {
    return { staff: null, error: null };
  }

  const result = await getBrokerStaff({ staffId }, { attempt: 1 });

  if (!result.ok) {
    // The raw TAI error stays in `tai_api_calls`; the page gets the outcome.
    return { staff: null, error: "Could not load this staff member from TAI." };
  }

  const match = asBrokerStaff(result.data).find((entry) => entry.staffId === staffId);

  return { staff: match ? toStaffDetail(match) : null, error: null };
}
