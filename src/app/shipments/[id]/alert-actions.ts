"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { requireSession } from "@/lib/auth/guard";
import { loadAlertTypes, type AlertTypeOption } from "@/lib/tai/alert-types";
import { listAlerts, raiseAlert, resolveAlert, type AlertListItem } from "@/lib/tai/alerts";
import { drainOutboundJobs } from "@/lib/tai/outbound-worker";

export type AlertsState = {
  alerts: AlertListItem[];
  error: string | null;
  notice: string | null;
};

export type AlertTypesState = {
  options: AlertTypeOption[];
  /** Set when TAI could not be reached and no cached list exists. */
  error: string | null;
};

/** Alert types for the dropdown, straight from TAI's Broker API. */
export async function fetchAlertTypes(): Promise<AlertTypesState> {
  await requireSession();
  return loadAlertTypes();
}

/**
 * Pushes the freshly queued job at TAI without making the operator wait for it.
 * Failure here is not failure of the action — the job row is already durable
 * and the worker will retry it.
 */
function kickWorker() {
  after(async () => {
    try {
      await drainOutboundJobs(5);
    } catch (cause) {
      console.error("[outbound] drain failed:", cause);
    }
  });
}

export async function fetchAlerts(shipmentId: string): Promise<AlertsState> {
  await requireSession();
  return { alerts: await listAlerts(shipmentId), error: null, notice: null };
}

export async function createAlertAction(formData: FormData): Promise<AlertsState> {
  await requireSession();

  const shipmentId = String(formData.get("shipmentId") ?? "");
  const alertType = String(formData.get("alertType") ?? "").trim();

  const result = await raiseAlert(shipmentId, alertType);
  const alerts = await listAlerts(shipmentId);

  if (!result.ok) {
    return { alerts, error: result.error, notice: null };
  }

  kickWorker();
  revalidatePath(`/shipments/${shipmentId}`);

  return { alerts, error: null, notice: `Alert "${alertType}" raised and queued for TAI.` };
}

export async function resolveAlertAction(formData: FormData): Promise<AlertsState> {
  await requireSession();

  const shipmentId = String(formData.get("shipmentId") ?? "");
  const alertId = String(formData.get("alertId") ?? "");

  const result = await resolveAlert(shipmentId, alertId);
  const alerts = await listAlerts(shipmentId);

  if (!result.ok) {
    return { alerts, error: result.error, notice: null };
  }

  kickWorker();
  revalidatePath(`/shipments/${shipmentId}`);

  return { alerts, error: null, notice: "Alert resolved and queued for TAI." };
}
