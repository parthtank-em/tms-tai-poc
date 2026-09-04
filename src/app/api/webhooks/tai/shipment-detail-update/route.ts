import { receiveTaiWebhook } from "@/lib/tai/receive";

/**
 * Use case 2 — Shipment Details Updated (findings §2, §3).
 * Configure as TAI's `ShipmentDetailUpdateUrl`.
 *
 * Fires on any shipment field or child-record edit, and batches ~1 minute after
 * the triggering change — rapid edits coalesce into one delivery.
 */
export async function POST(request: Request): Promise<Response> {
  return receiveTaiWebhook(request, "SHIPMENT_DETAIL_UPDATE");
}
