import { getRadarWebhookToken } from "@/lib/radar/config";
import { readJson } from "@/lib/radar/http";
import { mapWebhook } from "@/lib/radar/mapper";
import { ingestEvents } from "@/lib/radar/service";
import { verifyRadarWebhook } from "@/lib/radar/webhook-auth";
import { mapTrackingWebhook } from "@/lib/tracking/radar";
import { ingestTrackingEvents } from "@/lib/tracking/service";

/**
 * `POST /api/webhooks/radar` — Radar's event webhook, shared by both POCs.
 *
 * Configure it in the Radar dashboard (Integrations → Webhooks) with this URL
 * and either delivery mode. Fails closed: without `RADAR_WEBHOOK_TOKEN` nothing
 * is accepted.
 *
 * Crossings of /tracking fences (`tms-track-*`) go to the tracking session;
 * everything else is offered to the Radar POC. The tracking side claims its
 * events first, because a geofence event also carries the user's active trip
 * and would otherwise be filed under a Radar POC trip too.
 *
 * Events that are neither POC's (places, regions, other projects' fences) are
 * acknowledged with 200 and dropped — a non-2xx would only make Radar retry
 * something we will never want.
 */
export async function POST(request: Request): Promise<Response> {
  const token = getRadarWebhookToken();
  if (!token) {
    console.error("[radar-webhook] RADAR_WEBHOOK_TOKEN is not set — rejecting delivery.");
    return Response.json({ error: "Webhook not configured." }, { status: 503 });
  }

  const auth = verifyRadarWebhook(request.headers, token);
  if (auth !== "AUTHORIZED") {
    console.warn(`[radar-webhook] rejected: ${auth}`);
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }

  const body = await readJson(request);
  const mapped = mapWebhook(body);
  if (!mapped) {
    return Response.json({ error: "Expected an `event` or `events` payload." }, { status: 400 });
  }

  const trackingEvents = mapTrackingWebhook(body);
  const trackingIds = new Set(trackingEvents.map((event) => event.id));
  const tripEvents = mapped.events.filter((event) => !trackingIds.has(event.id));

  const [trips, tracking] = await Promise.all([
    ingestEvents(tripEvents),
    ingestTrackingEvents(trackingEvents),
  ]);

  const received = mapped.events.length + mapped.ignored;

  return Response.json({
    received,
    ignored: received - tripEvents.length - trackingEvents.length,
    ...trips,
    tracking,
  });
}
