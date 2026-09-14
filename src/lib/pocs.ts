/**
 * The POCs this console hosts.
 *
 * Shared by the landing page at `/` and the header menu, so a POC is added in
 * one place. `/jumio-dashboard` in particular has no other entry point — if it
 * is missing from this list it is reachable by URL only.
 */
export type Poc = {
  title: string;
  /** Short label for the header menu, where the full title does not fit. */
  shortTitle: string;
  description: string;
  href: string;
};

export const pocs: Poc[] = [
  {
    title: "TMS-TAI Integration",
    shortTitle: "TMS-TAI",
    description: "Shipments synced from TAI, with stops, statuses and webhook history.",
    href: "/shipments",
  },
  {
    title: "Jumio Integration",
    shortTitle: "Jumio",
    description: "Driver identity verification: sessions, captured documents and results.",
    href: "/jumio-dashboard",
  },
  {
    title: "FMCSA Integration",
    shortTitle: "FMCSA",
    description: "Look up a motor carrier by USDOT number against the FMCSA QCMobile API.",
    href: "/fmcsa",
  },
];
