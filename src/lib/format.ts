/**
 * Display helpers.
 *
 * Timestamps are rendered in **UTC**, always. TAI sends ISO 8601 UTC (findings
 * §3) and Postgres stores these columns as `timestamp without time zone`, so
 * formatting in the viewer's local zone would silently shift every value and
 * make a shipment's timeline disagree with TAI's own screens.
 */

const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const DATE_ONLY = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
});

export function formatDateTime(value: Date | null | undefined): string {
  return value ? `${DATE_TIME.format(value)} UTC` : "—";
}

export function formatDate(value: Date | null | undefined): string {
  return value ? DATE_ONLY.format(value) : "—";
}

/**
 * Prisma returns Decimal columns as objects, which React cannot render.
 *
 * The digits are grouped by string surgery rather than via `Number`, so a value
 * wider than a float stays exact — the reason the column is Decimal to begin
 * with.
 */
export function formatDecimal(value: unknown, suffix = ""): string {
  if (value === null || value === undefined) return "—";

  const [whole, fraction] = String(value).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return `${fraction ? `${grouped}.${fraction}` : grouped}${suffix}`;
}

export function formatNumber(value: number | null | undefined, suffix = ""): string {
  return value === null || value === undefined ? "—" : `${value.toLocaleString("en-US")}${suffix}`;
}

export function formatText(value: string | null | undefined): string {
  return value?.trim() ? value : "—";
}

/** `OUT_FOR_DELIVERY` → `Out for delivery` */
export function humanizeEnum(value: string): string {
  const words = value.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Compact one-line address for a stop. */
export function formatLocation(stop: {
  city: string | null;
  state: string | null;
  postalCode: string | null;
}): string {
  const parts = [stop.city, stop.state].filter(Boolean).join(", ");
  return [parts, stop.postalCode].filter(Boolean).join(" ") || "—";
}
