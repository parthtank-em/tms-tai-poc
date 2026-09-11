import { getSession } from "@/lib/auth/guard";
import { startPickupVerification } from "@/lib/jumio/pickup";

/**
 * `POST /api/jumio/pickup` — start a selfie re-check for an enrolled driver.
 *
 * Returns the SDK token plus the ids the result call needs. Nothing is stored:
 * the browser holds the transaction for as long as the modal is open, and that
 * is the whole lifetime of a pickup check today.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await getSession();

  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { driverId?: unknown };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const driverId = typeof body.driverId === "string" ? body.driverId.trim() : "";

  if (!driverId) {
    return Response.json({ error: "driverId is required." }, { status: 400 });
  }

  const result = await startPickupVerification(driverId);

  if (!result.ok) {
    return Response.json({ error: result.reason }, { status: 502 });
  }

  return Response.json({
    accountId: result.accountId,
    workflowExecutionId: result.workflowExecutionId,
    acquisition: result.acquisition,
  });
}
