import { normalizeAlertType } from "./alert-types";
import { ALERTS_CREATE, ALERTS_RESOLVE } from "./outbound-worker";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Security alerts — use case 4 (findings §4.1).
 *
 * Raising an alert is a local write plus a queued outbound job, never a direct
 * call to TAI. That ordering is the point: the operator's action is durable the
 * moment it is recorded, and `tai_alert_id` stays null until `POST /Alerts`
 * comes back. An alert raised during a TAI outage is still an alert.
 */

export type AlertListItem = {
  id: string;
  alertType: string;
  resolved: boolean;
  taiAlertId: number | null;
  taiShipmentStopId: number | null;
  taiCreatedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  syncStatus: "SYNCED" | "PENDING" | "FAILED";
  syncError: string | null;
};

/**
 * Derives a per-alert sync state from its most recent job. `taiAlertId` alone
 * cannot say whether a resolve is still in flight.
 */
function deriveSyncStatus(
  taiAlertId: number | null,
  jobs: { status: string; lastError: string | null }[],
): { syncStatus: AlertListItem["syncStatus"]; syncError: string | null } {
  const latest = jobs.at(0);

  if (!latest) {
    return { syncStatus: taiAlertId === null ? "PENDING" : "SYNCED", syncError: null };
  }

  if (latest.status === "SUCCEEDED") return { syncStatus: "SYNCED", syncError: null };
  if (latest.status === "DEAD_LETTER") return { syncStatus: "FAILED", syncError: latest.lastError };

  return { syncStatus: "PENDING", syncError: latest.lastError };
}

export async function listAlerts(shipmentId: string): Promise<AlertListItem[]> {
  const alerts = await prisma.shipmentAlert.findMany({
    where: { shipmentId },
    orderBy: [{ resolved: "asc" }, { createdAt: "desc" }],
    include: {
      outboundJobs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true, lastError: true },
      },
    },
  });

  return alerts.map((alert) => ({
    id: alert.id,
    alertType: alert.alertType,
    resolved: alert.resolved,
    taiAlertId: alert.taiAlertId,
    taiShipmentStopId: alert.taiShipmentStopId,
    taiCreatedAt: alert.taiCreatedAt,
    resolvedAt: alert.resolvedAt,
    createdAt: alert.createdAt,
    ...deriveSyncStatus(alert.taiAlertId, alert.outboundJobs),
  }));
}

export type AlertMutationResult = { ok: true; alertId: string } | { ok: false; error: string };

async function loadShipment(shipmentId: string) {
  return prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: { id: true, taiShipmentId: true },
  });
}

export async function raiseAlert(
  shipmentId: string,
  rawAlertType: string,
): Promise<AlertMutationResult> {
  const alertType = normalizeAlertType(rawAlertType);
  if (!alertType) {
    return { ok: false, error: "Enter an alert type." };
  }

  const shipment = await loadShipment(shipmentId);
  if (!shipment) {
    return { ok: false, error: "Shipment not found." };
  }

  if (shipment.taiShipmentId === null) {
    // Every outbound call is addressed by TAI's integer id. Without it there is
    // nothing to send, so refuse rather than queue a job that can never succeed.
    return { ok: false, error: "This shipment has no TAI shipment ID, so an alert cannot be sent." };
  }

  const existing = await prisma.shipmentAlert.findFirst({
    where: { shipmentId, alertType, resolved: false },
    select: { id: true },
  });

  if (existing) {
    return { ok: false, error: `An open "${alertType}" alert already exists on this shipment.` };
  }

  const payload = {
    shipmentId: shipment.taiShipmentId,
    shipmentAlerts: [alertType],
  } satisfies Prisma.InputJsonValue & { shipmentId: number; shipmentAlerts: string[] };

  const alert = await prisma.$transaction(async (tx) => {
    const created = await tx.shipmentAlert.create({
      data: { shipmentId, alertType, resolved: false },
      select: { id: true },
    });

    await tx.outboundJob.create({
      data: {
        shipmentId,
        operation: ALERTS_CREATE,
        alertAction: "CREATE",
        alertTypes: [alertType],
        alertId: created.id,
        payload,
      },
    });

    await tx.shipmentEvent.create({
      data: {
        shipmentId,
        type: "SECURITY_ALERT_RAISED",
        source: "FREIGHTID_INTERNAL",
        occurredAt: new Date(),
        taiSyncStatus: "PENDING",
        details: { alertType, localAlertId: created.id },
      },
    });

    return created;
  });

  return { ok: true, alertId: alert.id };
}

export async function resolveAlert(
  shipmentId: string,
  alertId: string,
): Promise<AlertMutationResult> {
  const alert = await prisma.shipmentAlert.findFirst({
    where: { id: alertId, shipmentId },
    select: { id: true, alertType: true, resolved: true },
  });

  if (!alert) {
    return { ok: false, error: "Alert not found." };
  }

  if (alert.resolved) {
    return { ok: false, error: "That alert is already resolved." };
  }

  const shipment = await loadShipment(shipmentId);
  if (!shipment?.taiShipmentId) {
    return { ok: false, error: "This shipment has no TAI shipment ID, so it cannot be resolved." };
  }

  const payload = {
    shipmentId: shipment.taiShipmentId,
    shipmentAlerts: [alert.alertType],
  } satisfies Prisma.InputJsonValue & { shipmentId: number; shipmentAlerts: string[] };

  await prisma.$transaction(async (tx) => {
    // Resolved locally straight away — the operator's judgement does not wait
    // on TAI. The job carries the same decision outward.
    await tx.shipmentAlert.update({
      where: { id: alert.id },
      data: { resolved: true, resolvedAt: new Date() },
    });

    await tx.outboundJob.create({
      data: {
        shipmentId,
        operation: ALERTS_RESOLVE,
        alertAction: "RESOLVE",
        alertTypes: [alert.alertType],
        alertId: alert.id,
        payload,
      },
    });

    await tx.shipmentEvent.create({
      data: {
        shipmentId,
        type: "SECURITY_ALERT_RESOLVED",
        source: "FREIGHTID_INTERNAL",
        occurredAt: new Date(),
        taiSyncStatus: "PENDING",
        details: { alertType: alert.alertType, localAlertId: alert.id },
      },
    });
  });

  return { ok: true, alertId: alert.id };
}
