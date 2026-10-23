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

/** 503 when the Radar keys are missing. */
export function radarUnconfigured(): Response {
  return Response.json(
    {
      success: false,
      error: "Radar is not configured. Set RADAR_SECRET_KEY and NEXT_PUBLIC_RADAR_PUBLISHABLE_KEY.",
    },
    { status: 503 },
  );
}

/** 409 for points sent to a trip no phone has started. */
export function tripNotStarted(): Response {
  return Response.json(
    { success: false, error: "Radar trip has not been started — call POST /start first." },
    { status: 409 },
  );
}

export function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
