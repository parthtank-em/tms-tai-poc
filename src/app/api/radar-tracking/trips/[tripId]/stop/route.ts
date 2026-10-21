import { tripNotFound } from "@/lib/radar/http";
import { stopTrip } from "@/lib/radar/service";

/**
 * `POST /api/radar-tracking/trips/{tripId}/stop` — the device pressed Stop.
 *
 * Completes the Radar trip and deletes both fences. A Radar failure does not
 * fail the stop — it is shown on the trip page as `radarSyncError`.
 *
 * Stopping an already-completed trip is a 409, so a device that thinks it is
 * still tracking finds out it is not.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ tripId: string }> },
): Promise<Response> {
  const { tripId } = await context.params;
  const result = await stopTrip(tripId);

  if (result.outcome === "not_found") return tripNotFound();

  const { trip } = result;
  const body = {
    tripId: trip.id,
    status: trip.status,
    tripStatus: trip.tripStatus,
    endedAt: trip.endedAt,
    radarSyncError: trip.radarSyncError,
  };

  return result.outcome === "stopped"
    ? Response.json({ success: true, ...body })
    : Response.json({ success: false, error: "Radar trip is not active.", ...body }, { status: 409 });
}
