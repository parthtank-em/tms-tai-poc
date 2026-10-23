import { tripNotFound } from "@/lib/radar/http";
import { findTrip } from "@/lib/radar/service";

/**
 * `GET /api/radar-tracking/trips/{tripId}` — one trip, for the phone's trip
 * detail screen. Unauthenticated, like the other device endpoints.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ tripId: string }> },
): Promise<Response> {
  const { tripId } = await context.params;
  const trip = await findTrip(tripId);

  return trip ? Response.json(trip) : tripNotFound();
}
