/**
 * The single organization this POC creates staff in.
 *
 * Fixed rather than asked for. TAI publishes no organizations endpoint, so the
 * form had nothing to populate a picker from and a typed id was a silent way to
 * file someone under the wrong organization. `685263` is the one the roster
 * actually lives in — 21 of the 22 staff TAI returns; the other id it mentions,
 * 764020, has a single person in it.
 *
 * ⚠️ The **name** is ours, not TAI's. No endpoint on this API returns an
 * organization name anywhere — not on staff, not on shipments — so it is
 * configured here and shown read-only. If the id changes, this name must change
 * with it; nothing validates that they still agree.
 *
 * Deliberately free of imports, so the client form can read it without dragging
 * Prisma into the browser bundle — the same split as `reference-types.ts` and
 * `staff-fields.ts`. Promote both to env vars if this POC ever serves more than
 * one organization.
 */
export const ORGANIZATION_ID = 685263;

export const ORGANIZATION_NAME = "FWD Freight LLC";
