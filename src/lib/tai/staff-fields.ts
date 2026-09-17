/**
 * The staff vocabulary: the spec's closed enums, its field limits, and the
 * labels the form renders them with.
 *
 * Deliberately free of imports. `api-client.ts` reaches Prisma, so a client
 * component pulling a permission list from there would drag the server into the
 * browser bundle — which is exactly what it did, until this split. Same reason
 * `reference-types.ts` sits beside `reference-numbers.ts`.
 */

/**
 * `PublicAPICreateBrokerStaffRequest.defaultShipmentType`
 *
 * Kept for the request type in `api-client.ts` even though the form no longer
 * offers these: the type mirrors the spec, so the enum has to exist for a
 * future diff against TAI's docs to be a straight comparison.
 */
export const TAI_SHIPMENT_TYPES = [
  "LTL",
  "Truckload",
  "Domestic Freight",
  "Small Package",
  "Cartage",
  "Drayage",
] as const;

/** `PublicAPICreateBrokerStaffRequest.staffSettings` */
export const TAI_STAFF_SETTINGS = [
  "HideLTL",
  "ShowLTLCarriers",
  "ShowTruckload",
  "ShowAirFreight",
  "ShowInternationalAir",
  "ShipperReferenceRequired",
  "POReferenceRequired",
  "PayInvoices",
] as const;

/** `PublicAPICreateBrokerStaffRequest.tariffSettings` */
export const TAI_TARIFF_SETTINGS = [
  "NoRate",
  "ShowTariffName",
  "ShowGuaranteedRates",
  "ShowLCROnly",
  "ShowTariffMultipleCarrierRate",
] as const;

/**
 * `PublicAPICreateBrokerStaffRequest.permissions`
 *
 * ⚠️ TAI's own staff screen offers a *different* list — it shows "Advanced
 * Payments", "TMS Site Admin" and "Truckload Quoting Tools", none of which
 * appear in this enum, and omits several that do. This is the API's set, which
 * is the only one that can actually be sent.
 */
export const TAI_STAFF_PERMISSIONS = [
  "AccountingAPApproveBills",
  "AccountingAPPayments",
  "AccountingAPRevisions",
  "AccountingAPInvoicing",
  "AccountingARInvoicing",
  "AccountingARCollections",
  "AccountingARPayments",
  "AccountingARRevisions",
  "AccountingSync",
  "CommissionsApprove",
  "CommissionsAdmin",
  "ShipmentChangeCustomer",
  "LSPAddEdit",
  "LSPCarrierAddEdit",
  "MasterCarrierAddEdit",
  "ReportsBasic",
  "ReportsSales",
  "ReportsBusinessLevel",
  "TariffAddEdit",
  "MarginAddEdit",
  "BatchProcessing",
  "UserAllowedOrgAccess",
  "CustomerAddEdit",
  "HideExportToExcel",
  "LSPCarrierDetails",
] as const;

export type TaiShipmentType = (typeof TAI_SHIPMENT_TYPES)[number];
export type TaiStaffSetting = (typeof TAI_STAFF_SETTINGS)[number];
export type TaiTariffSetting = (typeof TAI_TARIFF_SETTINGS)[number];
export type TaiStaffPermission = (typeof TAI_STAFF_PERMISSIONS)[number];

/**
 * The shape `phone`, `mobile` and `fax` must match: a `+`, at least ten digits,
 * and an optional `x`-prefixed extension. No spaces, dashes or parentheses.
 */
export const TAI_PHONE_PATTERN = /^\+\d{10,}(x\d+)?$/;

/**
 * The spec's `maxLength` on each address field. Note how tight two of them are:
 * `state` is 2 characters and `zipCode` is 7 — narrower than they look, and
 * both enforced before the call rather than discovered through a 400.
 */
export const ADDRESS_LIMITS = {
  streetAddress: 300,
  streetAddressTwo: 300,
  city: 300,
  state: 2,
  zipCode: 7,
} as const;

/**
 * Turns a PascalCase enum value into words: `AccountingAPApproveBills` into
 * `Accounting AP Approve Bills`, `ShowLCROnly` into `Show LCR Only`.
 *
 * The second pass is what keeps acronyms intact — splitting a run of capitals
 * only where the last one begins a new word. TAI's own screens write these out
 * in prose, but the API takes the symbol, so the label is derived rather than
 * kept as a second hand-maintained list that could drift from the enum.
 *
 * Values that are already prose (`Domestic Freight`) pass through untouched.
 */
export function symbolLabel(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}
