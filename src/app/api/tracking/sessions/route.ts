import { getSession } from "@/lib/auth/guard";
import { badRequest, readJson } from "@/lib/tracking/http";
import { listSessions, startSession } from "@/lib/tracking/service";
import { parseStartSession } from "@/lib/tracking/validation";

/**
 * `POST /api/tracking/sessions` — the device pressed Start.
 *
 * Unauthenticated: authentication is out of scope for this POC (plan §1), and
 * the mobile app has no console session to present. Revisit before anything
 * real reports locations here.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = parseStartSession(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.error);

  const session = await startSession(parsed.value.deviceId);

  return Response.json(
    { sessionId: session.id, status: session.status, startedAt: session.startedAt },
    { status: 201 },
  );
}

/**
 * `GET /api/tracking/sessions` — every session, newest first, for the web list.
 *
 * Unlike the device endpoints this one is behind the console login: it is
 * only ever called from a signed-in browser, which already carries the cookie.
 */
export async function GET(): Promise<Response> {
  if (!(await getSession())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return Response.json(await listSessions());
}
