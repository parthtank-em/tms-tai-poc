import { getSession } from "@/lib/auth/guard";
import { isDocumentCheckSettled, syncDocumentCheckFromJumio } from "@/lib/jumio/document-check";
import { toDocumentCheckView } from "@/lib/jumio/document-presenter";
import { prisma } from "@/lib/prisma";

/**
 * `GET /api/jumio/documents/{id}` — the current state of a document check.
 *
 * The page polls this while a check is running. It returns FreightID's shape,
 * built by the presenter, so the endpoint and the screen cannot disagree.
 *
 * It also **pulls** when the callback has not pushed. A callback needs a
 * publicly reachable URL, which in development means a tunnel that may simply
 * not be running — and a demonstration that only works behind a tunnel is not
 * much of a demonstration. So a check that has been sitting unfinished for
 * longer than the grace period below is retrieved directly. When the callback
 * does arrive, it finds the work already done: both paths write the same rows
 * from the same source.
 */

/**
 * How long to let the callback have first go.
 *
 * Jumio usually answers within seconds. Pulling immediately would race the
 * callback and spend retrieval calls on a result that was about to arrive
 * anyway; waiting far longer would leave the screen sitting on "processing"
 * with nothing happening.
 */
const PULL_AFTER_MS = 15_000;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession();

  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

  const existing = await prisma.documentCheck.findUnique({
    where: { id },
    select: { id: true, status: true, startedAt: true, retrievedAt: true },
  });

  if (!existing) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const waitedLongEnough =
    Date.now() - (existing.retrievedAt ?? existing.startedAt).getTime() > PULL_AFTER_MS;

  if (!isDocumentCheckSettled(existing.status) && waitedLongEnough) {
    await syncDocumentCheckFromJumio(id);
  }

  const check = await prisma.documentCheck.findUnique({ where: { id } });

  if (!check) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  return Response.json(toDocumentCheckView(check));
}
