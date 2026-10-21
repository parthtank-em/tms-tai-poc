import { getSession } from "@/lib/auth/guard";
import { tripNotFound, unauthorized } from "@/lib/radar/http";
import { findTrip } from "@/lib/radar/service";

/** `GET /api/radar-tracking/trips/{tripId}` — one trip. Console login required. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ tripId: string }> },
): Promise<Response> {
  if (!(await getSession())) return unauthorized();

  const { tripId } = await context.params;
  const trip = await findTrip(tripId);

  return trip ? Response.json(trip) : tripNotFound();
}
