/**
 * The reference-number vocabulary, shared by the dialog and the server.
 *
 * Deliberately free of imports: `reference-numbers.ts` reaches Prisma and the
 * TAI client, so the client component cannot pull the constants from there
 * without dragging the server into the browser bundle. This is the same split
 * as `alert-types.ts` beside `alerts.ts`.
 */

/**
 * The reference types this screen reads and writes. TAI models a driver as a
 * set of shipment reference numbers rather than an entity of its own — see the
 * note on `Shipment.driverId` in the schema.
 *
 * These are TAI's own type names, spelled exactly as it returns them — the
 * phone number is "Driver Cell Phone Number", spaced, not "DriverCellPhoneNumber".
 * Read and write use the same string: the type is how a row is addressed, so a
 * value written under one spelling is invisible to a read of the other, which is
 * a silent failure — the field simply stays blank.
 *
 * The email type is one configured on the TAI org rather than one of TAI's
 * built-ins, so it is the org's spelling that has to match here.
 */
export const DRIVER_NAME_REFERENCE_TYPE = "Driver Name";
export const DRIVER_PHONE_REFERENCE_TYPE = "Driver Cell Phone Number";
export const DRIVER_EMAIL_REFERENCE_TYPE = "Driver Email";

/** `value` is free text in the spec; this is our own sanity bound. */
export const REFERENCE_VALUE_MAX = 200;

export type ReferenceNumber = {
  referenceType: string;
  value: string;
};

/**
 * The driver as this screen shows it: one input per field, mapped to the TAI
 * reference type that holds it. This object is the single list of driver
 * fields — the type, the empty value and every helper below are derived from
 * it, so adding a fourth field is one line here and one input in the dialog.
 *
 * The reference types stay on this side of the boundary so the dialog deals in
 * `name` and `email` rather than in TAI's type names.
 */
export const DRIVER_FIELD_TYPES = {
  name: DRIVER_NAME_REFERENCE_TYPE,
  phone: DRIVER_PHONE_REFERENCE_TYPE,
  email: DRIVER_EMAIL_REFERENCE_TYPE,
} as const;

export type DriverField = keyof typeof DRIVER_FIELD_TYPES;
export type DriverFields = Record<DriverField, string>;

/** Iteration order is the order the fields are declared above, and so is the
 * order they are written to TAI — nothing depends on it, but it keeps the
 * request bodies in the call log readable. */
export const DRIVER_FIELD_KEYS = Object.keys(DRIVER_FIELD_TYPES) as DriverField[];

function mapDriverFields(value: (key: DriverField) => string): DriverFields {
  return Object.fromEntries(DRIVER_FIELD_KEYS.map((key) => [key, value(key)])) as DriverFields;
}

export const EMPTY_DRIVER: DriverFields = mapDriverFields(() => "");

/**
 * Pulls the driver out of a shipment's reference numbers. A type TAI does not
 * hold reads as an empty string, which is the same thing the input shows — so
 * "no driver yet" and "driver cleared" need no distinction anywhere above this.
 *
 * Takes the first row of each type: TAI can return a type more than once (see
 * the duplicate-row note in `reference-numbers.ts`), and there is nothing to
 * choose between identical rows.
 */
export function toDriverFields(entries: ReferenceNumber[]): DriverFields {
  return mapDriverFields(
    (key) => entries.find((entry) => entry.referenceType === DRIVER_FIELD_TYPES[key])?.value ?? "",
  );
}

/**
 * Identity of a reference number: the type alone is not unique. TAI can return
 * the same type more than once, so anything keying on these rows — the dedupe
 * on read, the React key in the list — has to use both fields.
 */
export function referenceKey(entry: ReferenceNumber): string {
  return `${entry.referenceType} ${entry.value}`;
}

/**
 * Collapses whitespace. Both sides run it before comparing, so a change that is
 * only spacing is not a change, and the server stores what the dialog compared.
 */
export function normalizeReferenceValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeDriverFields(fields: DriverFields): DriverFields {
  return mapDriverFields((key) => normalizeReferenceValue(fields[key]));
}

export function driverFieldsEqual(a: DriverFields, b: DriverFields): boolean {
  return DRIVER_FIELD_KEYS.every((key) => a[key] === b[key]);
}
