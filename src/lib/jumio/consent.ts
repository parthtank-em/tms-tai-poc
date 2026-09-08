/**
 * Where the consenting user is (§2.4).
 *
 * Jumio requires `userConsent.userIp` and `userConsent.userLocation.country` on
 * every account call, and rejects the request outright without them. The
 * country must be an ISO 3166-1 **alpha-3** code (`USA`, not `US`), and when it
 * is `USA` the state is required too — US biometric-privacy law varies by
 * state, which is the whole reason Jumio asks.
 *
 * This is a compliance field, so it is never guessed. It comes from the
 * platform's geolocation of the request, or from explicit configuration, and if
 * neither is available the verification refuses to start rather than sending a
 * plausible-looking default.
 */

/** ISO 3166-1 alpha-2 → alpha-3, for the countries this POC is likely to see. */
const ALPHA2_TO_ALPHA3: Record<string, string> = {
  AE: "ARE", AR: "ARG", AT: "AUT", AU: "AUS", BD: "BGD", BE: "BEL", BR: "BRA",
  CA: "CAN", CH: "CHE", CL: "CHL", CN: "CHN", CO: "COL", CZ: "CZE", DE: "DEU",
  DK: "DNK", EG: "EGY", ES: "ESP", FI: "FIN", FR: "FRA", GB: "GBR", GR: "GRC",
  HU: "HUN", ID: "IDN", IE: "IRL", IL: "ISR", IN: "IND", IT: "ITA", JP: "JPN",
  KE: "KEN", KR: "KOR", LK: "LKA", MX: "MEX", MY: "MYS", NG: "NGA", NL: "NLD",
  NO: "NOR", NP: "NPL", NZ: "NZL", PH: "PHL", PK: "PAK", PL: "POL", PT: "PRT",
  RO: "ROU", RU: "RUS", SA: "SAU", SE: "SWE", SG: "SGP", TH: "THA", TR: "TUR",
  UA: "UKR", US: "USA", VN: "VNM", ZA: "ZAF",
};

export type ConsentLocation = { country: string; state: string | null };

/** Already alpha-3, or convertible from alpha-2. Anything else is not a country code. */
export function toAlpha3(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase();
  if (!code) return null;

  if (code.length === 3) return code;
  if (code.length === 2) return ALPHA2_TO_ALPHA3[code] ?? null;

  return null;
}

/**
 * Resolve the consent location for a request.
 *
 * Explicit configuration wins over geolocation: an operator running the POC
 * from one country on behalf of drivers in another needs to be able to say so.
 * `x-vercel-ip-country` is alpha-2 and `x-vercel-ip-country-region` is the
 * subdivision code, which for the US is exactly the two-letter state.
 *
 * Returns null when the country cannot be established — the caller must then
 * refuse rather than invent one.
 */
export function resolveConsentLocation(headers: Headers): ConsentLocation | null {
  const configuredCountry = toAlpha3(process.env.JUMIO_CONSENT_COUNTRY);
  const configuredState = process.env.JUMIO_CONSENT_STATE?.trim().toUpperCase() || null;

  const country = configuredCountry ?? toAlpha3(headers.get("x-vercel-ip-country"));

  if (!country) return null;

  const geoState = headers.get("x-vercel-ip-country-region")?.trim().toUpperCase() || null;
  const state = configuredState ?? geoState;

  // Outside the US the state is noise; inside it, it is mandatory.
  if (country !== "USA") {
    return { country, state: null };
  }

  return state ? { country, state } : null;
}

/** Why the location could not be resolved, in words an operator can act on. */
export function consentLocationHint(): string {
  return (
    "Could not determine the end user's country for the consent record. " +
    "Set JUMIO_CONSENT_COUNTRY (ISO 3166-1 alpha-3, e.g. USA) and, for the USA, " +
    "JUMIO_CONSENT_STATE (e.g. CA)."
  );
}
