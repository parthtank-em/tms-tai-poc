import { getSession } from "@/lib/auth/guard";
import { toStatusResponse } from "@/lib/jumio/presenter";
import { latestVerification } from "@/lib/jumio/verification";

/**
 * `GET /api/jumio/status?driverId=...` — the current verification state (§19).
 *
 * Returns FreightID's stable shape, never Jumio's. The response is built by the
 * presenter, which is also what the UI reads, so the two can never drift apart
 * — and neither can reach the raw callback or retrieval payloads.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getSession();

  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const driverId = new URL(request.url).searchParams.get("driverId")?.trim();

  if (!driverId) {
    return Response.json({ error: "driverId is required." }, { status: 400 });
  }

  const verification = await latestVerification(driverId);

  if (!verification) {
    return Response.json({ status: null, decision: null }, { status: 404 });
  }

  return Response.json(toStatusResponse(verification));
}
