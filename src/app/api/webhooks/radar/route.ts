import { getRadarWebhookToken } from "@/lib/radar/config";
import { readJson } from "@/lib/radar/http";
import { mapWebhook } from "@/lib/radar/mapper";
import { ingestEvents } from "@/lib/radar/service";
import { verifyRadarWebhook } from "@/lib/radar/webhook-auth";

/**
 * `POST /api/webhooks/radar` — Radar's event webhook.
 *
 * Configure it in the Radar dashboard (Integrations → Webhooks) with this URL
 * and either delivery mode. Fails closed: without `RADAR_WEBHOOK_TOKEN` nothing
 * is accepted.
 *
 * Events that are not ours (places, regions, other projects' fences) are
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

  const mapped = mapWebhook(await readJson(request));
  if (!mapped) {
    return Response.json({ error: "Expected an `event` or `events` payload." }, { status: 400 });
  }

  const result = await ingestEvents(mapped.events);

  return Response.json({ received: mapped.events.length + mapped.ignored, ignored: mapped.ignored, ...result });
}
