import { getSession } from "@/lib/auth/guard";
import { callbackClientIp } from "@/lib/jumio/callback-auth";
import { startDriverVerification } from "@/lib/jumio/verification";

/**
 * `POST /api/jumio/start` — begin identity verification for a driver (§8).
 *
 * Returns the Jumio Web Client URL for the browser to navigate to. It never
 * returns a token, an account id, or anything else Jumio-side: the response is
 * one URL and nothing more.
 *
 * Consent must already have been given on the FreightID consent screen; this
 * endpoint records when, and from where, and refuses without it (§9).
 */
export async function POST(request: Request): Promise<Response> {
  const session = await getSession();

  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { driverId?: unknown; consent?: unknown; country?: unknown; state?: unknown };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const driverId = typeof body.driverId === "string" ? body.driverId.trim() : "";

  if (!driverId) {
    return Response.json({ error: "driverId is required." }, { status: 400 });
  }

  if (body.consent !== true) {
    return Response.json(
      { error: "Consent is required before identity verification can start." },
      { status: 400 },
    );
  }

  const result = await startDriverVerification(driverId, {
    obtainedAt: new Date(),
    ip: callbackClientIp(request.headers),
    country: typeof body.country === "string" ? body.country.trim() || null : null,
    state: typeof body.state === "string" ? body.state.trim() || null : null,
  });

  if (!result.ok) {
    // The reason is already sanitized by the service — no Jumio payloads, no
    // credentials, no configuration detail (§20).
    return Response.json({ error: result.reason, retryable: result.retryable }, { status: 502 });
  }

  return Response.json({ redirectUrl: result.redirectUrl, verificationId: result.verificationId });
}
