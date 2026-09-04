import { receiveTaiWebhook } from "@/lib/tai/receive";

/**
 * Use case 1 — Shipment Created in TMS (findings §2, §3).
 * Configure as TAI's `ShipmentCreateUrl`.
 */
export async function POST(request: Request): Promise<Response> {
  return receiveTaiWebhook(request, "SHIPMENT_CREATE");
}
