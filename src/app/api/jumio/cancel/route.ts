import { getSession } from "@/lib/auth/guard";
import { abandonVerification } from "@/lib/jumio/verification";

/**
 * `POST /api/jumio/cancel` — abandon an attempt that never started capturing.
 *
 * Without this, closing the capture screens leaves the row at `INITIATED`,
 * which counts as active and blocks the driver from starting again until
 * Jumio's token expires. The service refuses anything further along, so this
 * cannot cancel a journey the driver is actually in the middle of.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await getSession();

  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { verificationId?: unknown };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const verificationId = typeof body.verificationId === "string" ? body.verificationId.trim() : "";

  if (!verificationId) {
    return Response.json({ error: "verificationId is required." }, { status: 400 });
  }

  // `false` means the attempt had already moved on — not an error, just nothing
  // to cancel, and the caller navigates away either way.
  const cancelled = await abandonVerification(verificationId);

  return Response.json({ cancelled });
}
