/**
 * The one Jumio shape the browser is allowed to know about.
 *
 * Kept out of `config.ts` and `verification.ts` because both are server-only —
 * `config.ts` holds the client secret — while these types are exactly what
 * `POST /api/jumio/start` returns. Types, plus the pure helpers the consent
 * screen and the route need to agree on a channel. No secrets, no I/O.
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

/** Both channels, in the order the consent screen offers them. */
export const ACQUISITION_CHANNELS: readonly JumioAcquisitionChannel[] = ["sdk", "redirect"];

/**
 * Narrow an untrusted value to a channel, or null.
 *
 * Shared by the consent screen, `POST /api/jumio/start` and `config.ts` so the
 * three agree on the spelling — the browser now picks the channel, which makes
 * this a request input and not just a configuration read.
 */
export function parseAcquisitionChannel(value: unknown): JumioAcquisitionChannel | null {
  return value === "sdk" || value === "redirect" ? value : null;
}

/**
 * The channel pre-selected on the consent screen when the driver expresses no
 * preference.
 *
 * Lenient where `config.ts` is strict: a typo in the environment should not
 * stop the screen from rendering, and the server re-reads the same variable
 * strictly on the call that actually matters.
 */
export function defaultAcquisitionChannel(): JumioAcquisitionChannel {
  return parseAcquisitionChannel(process.env.NEXT_PUBLIC_JUMIO_ACQUISITION_CHANNEL) ?? "sdk";
}
