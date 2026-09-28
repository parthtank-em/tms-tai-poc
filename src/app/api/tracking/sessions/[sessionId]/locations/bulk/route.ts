import { badRequest, readJson, sessionNotFound } from "@/lib/tracking/http";
import { recordLocations } from "@/lib/tracking/service";
import { parseBulkLocations } from "@/lib/tracking/validation";

/**
 * `POST /api/tracking/sessions/{sessionId}/locations/bulk` — the offline queue.
 *
 * Idempotent on location id: resending a batch after a lost response inserts
 * nothing new, and `inserted` says so. `skipped` lets the device tell a retry
 * apart from a first send.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const parsed = parseBulkLocations(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const { sessionId } = await context.params;
  const result = await recordLocations(sessionId, parsed.value);

  if (!result.found) return sessionNotFound();

  return Response.json({
    success: true,
    inserted: result.inserted,
    skipped: parsed.value.length - result.inserted,
  });
}
