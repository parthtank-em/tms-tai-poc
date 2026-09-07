/**
 * Alert-type vocabulary for `POST /Alerts` (findings §4.1).
 *
 * ⚠️ **These strings are unconfirmed.** The accepted `shipmentAlerts` values are
 * not documented, and getting the list from TAI is an open action item (§9).
 * They are offered as suggestions only — `shipment_alerts.alert_type` is a text
 * column precisely so an unexpected value is never lost, and the form accepts
 * free text.
 *
 * Once TAI supplies the real enum, replace this list and consider tightening
 * the column.
 */
export const SUGGESTED_ALERT_TYPES = [
  "Theft",
  "Cargo Damage",
  "Seal Broken",
  "Unauthorized Stop",
  "Route Deviation",
  "Driver Unreachable",
  "Temperature Excursion",
  "Accident",
  "Delay",
  "Other",
] as const;

/** Guards against blank or absurdly long values before they reach TAI. */
export function normalizeAlertType(value: string): string | null {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 && trimmed.length <= 120 ? trimmed : null;
}
