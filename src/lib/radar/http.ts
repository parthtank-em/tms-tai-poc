/**
 * Small helpers shared by the Radar POC route handlers.
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

export function tripNotFound(): Response {
  return Response.json({ success: false, error: "Radar trip not found." }, { status: 404 });
}

export function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
