import { getSession } from "@/lib/auth/guard";
import { drainOutboundJobs } from "@/lib/tai/outbound-worker";

/**
 * Runs the outbound job queue (findings §4.1, §7).
 *
 * Raising an alert kicks the worker via `after()`, which covers the happy path.
 * This endpoint is what retries a job whose earlier attempt failed — nothing
 * else re-runs the backoff schedule, so point a scheduler at it (every minute
 * or so) in any environment where TAI outages matter.
 *
 * Guarded by the admin session. A real cron needs its own credential; that is
 * deliberately not built yet rather than being faked with a shared secret.
 */
export async function POST(): Promise<Response> {
  const session = await getSession();

  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { processed } = await drainOutboundJobs(25);

  return Response.json({ processed });
}
