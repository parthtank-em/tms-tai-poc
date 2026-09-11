import { getSession } from "@/lib/auth/guard";
import { JumioApiError } from "@/lib/jumio/client";
import { retrievePickupResult } from "@/lib/jumio/pickup";

/**
 * `GET /api/jumio/pickup/result?accountId=…&workflowExecutionId=…`
 *
 * Reads the outcome from Jumio's Retrieval API and returns it. No callback and
 * no row — the identifiers come back from the browser because that is the only
 * place this transaction was ever recorded.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getSession();

  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const accountId = params.get("accountId")?.trim();
  const workflowExecutionId = params.get("workflowExecutionId")?.trim();

  if (!accountId || !workflowExecutionId) {
    return Response.json(
      { error: "accountId and workflowExecutionId are required." },
      { status: 400 },
    );
  }

  try {
    return Response.json(await retrievePickupResult(accountId, workflowExecutionId));
  } catch (error) {
    const reason =
      error instanceof JumioApiError ? error.message : "Could not read the pickup result.";

    console.error(`[jumio] Pickup retrieval failed for ${workflowExecutionId}: ${reason}`);

    return Response.json({ error: reason }, { status: 502 });
  }
}
