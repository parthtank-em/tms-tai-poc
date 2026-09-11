/**
 * The one Jumio shape the browser is allowed to know about.
 *
 * Kept out of `config.ts` and `verification.ts` because both are server-only —
 * `config.ts` holds the client secret — while these types are exactly what
 * `POST /api/jumio/start` returns. Types only.
 */

/** The datacenter as `<jumio-sdk dc="…">` spells it. `config.ts` maps it from `JUMIO_DATACENTER`. */
export type JumioSdkDatacenter = "us" | "eu" | "sgp";

/** `sdk` embeds Jumio's Web SDK in our page; `redirect` sends the browser to their Web Client. */
export type JumioAcquisitionChannel = "sdk" | "redirect";

/**
 * What the browser needs to put a camera in front of the driver.
 *
 * One account call returns both handles. The server picks one, so the browser
 * never holds a credential for a channel it is not using. The SDK token is
 * scoped to a single workflow execution and is never stored or logged.
 */
export type JumioAcquisition =
  | { channel: "redirect"; redirectUrl: string }
  | { channel: "sdk"; token: string; datacenter: JumioSdkDatacenter; locale: string };
