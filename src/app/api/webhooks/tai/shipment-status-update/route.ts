import { receiveTaiWebhook } from "@/lib/tai/receive";

/**
 * Use case 2 — Shipment Details Updated, status half (findings §2, §3).
 * Configure as TAI's `ShipmentStatusUpdateUrl`.
 *
 * Fires on a status change, a stop-date edit, an EDI 214, or a tracking update.
 * The status label it carries depends on TAI's `Version` setting — see
 * src/lib/tai/status.ts.
 */
export async function POST(request: Request): Promise<Response> {
  return receiveTaiWebhook(request, "SHIPMENT_STATUS_UPDATE");
}
