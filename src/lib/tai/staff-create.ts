import {
  createBrokerStaff,
  type PublicApiAddress,
  type PublicApiCreateBrokerStaffRequest,
} from "./api-client";
import { isTaiCountry } from "./countries";
// Set server-side and never carried in the form, so a crafted request cannot
// file someone under a different organization.
import { ORGANIZATION_ID } from "./organization";
import { ADDRESS_LIMITS, TAI_PHONE_PATTERN, TAI_STAFF_PERMISSIONS } from "./staff-fields";

/**
 * Creating a broker staff member — `POST /PublicApi/Staff/v2/Broker`.
 *
 * A direct call, like the rest of the staff and reference-number work: TAI owns
 * the roster and there is no local table to write first.
 *
 * ⚠️ The spec marks **only** `organizationId` as required — a body with nothing
 * else would satisfy it. That cannot be what TAI means by a staff member, and a
 * person created without a login could not sign in. So this layer requires name,
 * login, password, email and organization, and says which one is missing rather
 * than forwarding a doomed request and relaying a bare 400 string.
 */

export type StaffDraft = {
  contactName: string;
  login: string;
  password: string;
  confirmPassword: string;
  email: string;
  title: string;
  referenceNumber: string;
  enabled: boolean;
  phone: string;
  mobile: string;
  fax: string;
  streetAddress: string;
  streetAddressTwo: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  permissions: string[];
};

/** Field name → message, so the form can mark the offending input. */
export type FieldErrors = Partial<Record<keyof StaffDraft, string>>;

export type CreateStaffResult =
  | { ok: true; staffId: number | null; name: string }
  | { ok: false; error: string; fieldErrors: FieldErrors };

function clean(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Strips the punctuation people type into phone fields — spaces, dashes,
 * brackets, dots — since TAI accepts none of it. What is left still has to
 * match the pattern; this only spares the operator a rejection over formatting
 * they had no way to know was forbidden.
 */
export function normalizePhone(value: string): string {
  return value.replace(/[\s()\-.]/g, "");
}

function validate(draft: StaffDraft): FieldErrors {
  const errors: FieldErrors = {};

  if (!clean(draft.contactName)) errors.contactName = "Enter a name.";
  if (!clean(draft.login)) errors.login = "Enter a login.";

  if (!draft.password) {
    errors.password = "Enter a password.";
  } else if (draft.password !== draft.confirmPassword) {
    // Caught here rather than only in the browser: the confirm field never
    // reaches TAI, so this is the last place the mismatch can be seen at all.
    errors.confirmPassword = "The passwords do not match.";
  }

  const email = clean(draft.email);
  if (!email) {
    errors.email = "Enter an email address.";
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = "Enter a valid email address.";
  }

  for (const field of ["phone", "mobile", "fax"] as const) {
    const value = normalizePhone(draft[field]);
    if (value && !TAI_PHONE_PATTERN.test(value)) {
      errors[field] = "Use +15551234567, or +15551234567x89 to include an extension.";
    }
  }

  const state = clean(draft.state);
  if (state && state.length > ADDRESS_LIMITS.state) {
    errors.state = `Use the ${ADDRESS_LIMITS.state}-letter abbreviation.`;
  }

  const zipCode = clean(draft.zipCode);
  if (zipCode && zipCode.length > ADDRESS_LIMITS.zipCode) {
    errors.zipCode = `${ADDRESS_LIMITS.zipCode} characters or fewer.`;
  }

  for (const field of ["streetAddress", "streetAddressTwo", "city"] as const) {
    if (clean(draft[field]).length > ADDRESS_LIMITS[field]) {
      errors[field] = `${ADDRESS_LIMITS[field]} characters or fewer.`;
    }
  }

  if (draft.country && !isTaiCountry(draft.country)) {
    errors.country = "Choose a country from the list.";
  }

  return errors;
}

/** Drops the address entirely when every part of it is blank. */
function toAddress(draft: StaffDraft, contactName: string): PublicApiAddress | undefined {
  const address: PublicApiAddress = {};

  if (clean(draft.streetAddress)) address.streetAddress = clean(draft.streetAddress);
  if (clean(draft.streetAddressTwo)) address.streetAddressTwo = clean(draft.streetAddressTwo);
  if (clean(draft.city)) address.city = clean(draft.city);
  if (clean(draft.state)) address.state = clean(draft.state).toUpperCase();
  if (clean(draft.zipCode)) address.zipCode = clean(draft.zipCode);
  if (draft.country) address.country = draft.country;

  if (Object.keys(address).length === 0) return undefined;

  // The address carries its own contact name in the spec; without one TAI has
  // an address attached to nobody.
  return { ...address, contactName };
}

/**
 * Keeps only values the spec's enum contains.
 *
 * Every one of these arrives as a checkbox value the form itself rendered, so
 * in practice they are always valid — this is the backstop for a hand-crafted
 * request, and it drops the unknown value rather than failing the whole
 * submission over it.
 */
function onlyKnown<T extends string>(selected: string[], allowed: readonly T[]): T[] {
  const set = new Set<string>(allowed);
  return selected.filter((value): value is T => set.has(value));
}

export async function createStaff(draft: StaffDraft): Promise<CreateStaffResult> {
  const fieldErrors = validate(draft);

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors };
  }

  const contactName = clean(draft.contactName);

  const body: PublicApiCreateBrokerStaffRequest = {
    organizationId: ORGANIZATION_ID,
    login: clean(draft.login),
    password: draft.password,
    email: clean(draft.email),
    contactName,
    enabled: draft.enabled,
    permissions: onlyKnown(draft.permissions, TAI_STAFF_PERMISSIONS),
  };

  if (clean(draft.title)) body.title = clean(draft.title);
  if (clean(draft.referenceNumber)) body.referenceNumber = clean(draft.referenceNumber);

  for (const field of ["phone", "mobile", "fax"] as const) {
    const value = normalizePhone(draft[field]);
    if (value) body[field] = value;
  }

  const address = toAddress(draft, contactName);
  if (address) body.address = address;

  // The seven notification flags, the three settings arrays and the default
  // shipment types are all left out of the body entirely. The form does not ask
  // about them, so sending `false` for each would be asserting a choice nobody
  // made — omitting them lets TAI apply its own defaults.
  const result = await createBrokerStaff(body, { attempt: 1 });

  if (!result.ok) {
    // A 400 here is a bare string from TAI — the one case where relaying it is
    // more useful than a generic line, since it names what it disliked.
    const detail = result.status === 400 ? extractMessage(result.error) : null;
    return {
      ok: false,
      error: detail ?? "TAI rejected the new staff member. Nothing has been created.",
      fieldErrors: {},
    };
  }

  const staffId = (result.data as { staffId?: number } | null)?.staffId ?? null;
  return { ok: true, staffId: typeof staffId === "number" ? staffId : null, name: contactName };
}

/**
 * Pulls TAI's own words out of `TAI responded 400: "..."`. Quotes and braces
 * are stripped so a JSON-encoded string does not reach the operator with its
 * punctuation intact.
 */
function extractMessage(error: string): string | null {
  // `[\s\S]` rather than the `s` flag: the project's target predates it.
  const match = error.match(/TAI responded \d+:\s*([\s\S]*)$/);
  const body = match?.[1]?.trim();
  if (!body) return null;

  const unquoted = body.replace(/^"|"$/g, "").trim();
  return unquoted.length > 0 && unquoted.length < 300 ? unquoted : null;
}
