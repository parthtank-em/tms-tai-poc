/**
 * Small helpers shared by the tracking route handlers.
 */

/** The body as JSON, or `undefined` when it is missing or not JSON. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function badRequest(error: string): Response {
  return Response.json({ success: false, error }, { status: 400 });
}

export function sessionNotFound(): Response {
  return Response.json({ success: false, error: "Tracking session not found." }, { status: 404 });
}
