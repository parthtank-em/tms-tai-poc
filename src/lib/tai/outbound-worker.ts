import { randomUUID } from "node:crypto";

import { createAlerts, resolveAlerts, type AlertRequest, type TaiAlert } from "./api-client";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Drains the outbound job queue (findings §4.1).
 *
 * Inbound webhooks are at-most-once and TAI owns delivery; outbound is the
 * mirror image — **FreightID owns reliability here**. A TAI outage must delay an
 * alert, never drop it, so nothing is pushed except through an `outbound_jobs`
 * row that survives restarts and is retried with backoff.
 */

export const ALERTS_CREATE = "ALERTS_CREATE";
export const ALERTS_RESOLVE = "ALERTS_RESOLVE";

/** 30s, 1m, 2m, 4m … capped at an hour. */
function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** (attempt - 1), 60 * 60 * 1000);
}

/** A job locked longer than this is presumed dead and may be reclaimed. */
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

type ClaimedJob = {
  id: string;
  operation: string;
  alertId: string | null;
  shipmentId: string | null;
  payload: Prisma.JsonValue;
  attemptCount: number;
  maxAttempts: number;
};

/**
 * Claims one due job. `updateMany` with the status in the filter makes the
 * claim atomic, so two concurrent workers cannot take the same row.
 */
async function claimNextJob(workerId: string): Promise<ClaimedJob | null> {
  const candidate = await prisma.outboundJob.findFirst({
    where: {
      status: { in: ["PENDING", "IN_FLIGHT"] },
      nextAttemptAt: { lte: new Date() },
      OR: [
        { status: "PENDING" },
        // Reclaim a job whose worker died mid-flight.
        { status: "IN_FLIGHT", lockedAt: { lt: new Date(Date.now() - LOCK_TIMEOUT_MS) } },
      ],
    },
    orderBy: { nextAttemptAt: "asc" },
    select: { id: true, status: true },
  });

  if (!candidate) return null;

  const claim = await prisma.outboundJob.updateMany({
    where: { id: candidate.id, status: candidate.status },
    data: {
      status: "IN_FLIGHT",
      lockedAt: new Date(),
      lockedBy: workerId,
      attemptCount: { increment: 1 },
    },
  });

  if (claim.count === 0) return null; // Someone else won the race.

  return prisma.outboundJob.findUnique({
    where: { id: candidate.id },
    select: {
      id: true,
      operation: true,
      alertId: true,
      shipmentId: true,
      payload: true,
      attemptCount: true,
      maxAttempts: true,
    },
  });
}

/** Copies whatever TAI returned onto the local alert row. */
async function applyTaiResponse(alertId: string, alertType: string, alerts: TaiAlert[]) {
  const match =
    alerts.find((alert) => alert.type?.toLowerCase() === alertType.toLowerCase()) ?? alerts[0];

  if (!match) return;

  await prisma.shipmentAlert.update({
    where: { id: alertId },
    data: {
      // §9: TAI returns a shipmentStopId it does not accept in the request.
      // Whatever association it made is recorded rather than second-guessed.
      ...(typeof match.alertId === "number" ? { taiAlertId: match.alertId } : {}),
      ...(typeof match.shipmentStopId === "number"
        ? { taiShipmentStopId: match.shipmentStopId }
        : {}),
      ...(match.createdDate && !Number.isNaN(Date.parse(match.createdDate))
        ? { taiCreatedAt: new Date(match.createdDate) }
        : {}),
      ...(typeof match.resolved === "boolean" ? { resolved: match.resolved } : {}),
    },
  });
}

async function runJob(job: ClaimedJob): Promise<void> {
  const payload = job.payload as unknown as AlertRequest;
  const context = { jobId: job.id, shipmentId: job.shipmentId ?? undefined, attempt: job.attemptCount };

  const result =
    job.operation === ALERTS_RESOLVE
      ? await resolveAlerts(payload, context)
      : await createAlerts(payload, context);

  if (result.ok) {
    if (job.alertId) {
      await applyTaiResponse(job.alertId, payload.shipmentAlerts[0] ?? "", result.alerts);
    }

    await prisma.outboundJob.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        completedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    });

    // Mark the originating event as synced.
    if (job.alertId) {
      await prisma.shipmentEvent.updateMany({
        where: { shipmentId: job.shipmentId ?? undefined, taiSyncStatus: "PENDING" },
        data: { taiSyncStatus: "SYNCED", taiSyncedAt: new Date(), taiSyncError: null },
      });
    }
    return;
  }

  const exhausted = !result.retryable || job.attemptCount >= job.maxAttempts;

  await prisma.outboundJob.update({
    where: { id: job.id },
    data: {
      // DEAD_LETTER means a human has to look. It stops the retry loop without
      // pretending the alert reached TAI.
      status: exhausted ? "DEAD_LETTER" : "PENDING",
      nextAttemptAt: exhausted ? new Date() : new Date(Date.now() + backoffMs(job.attemptCount)),
      lockedAt: null,
      lockedBy: null,
      lastError: result.error,
      ...(exhausted ? { completedAt: new Date() } : {}),
    },
  });

  if (exhausted && job.shipmentId) {
    await prisma.shipmentEvent.updateMany({
      where: { shipmentId: job.shipmentId, taiSyncStatus: "PENDING" },
      data: { taiSyncStatus: "FAILED", taiSyncError: result.error },
    });
  }
}

/**
 * Processes up to `limit` due jobs. Safe to call from a request handler, a
 * cron, or `after()` — claiming is atomic, so overlapping runs are fine.
 */
export async function drainOutboundJobs(limit = 10): Promise<{ processed: number }> {
  const workerId = randomUUID();
  let processed = 0;

  for (let i = 0; i < limit; i += 1) {
    const job = await claimNextJob(workerId);
    if (!job) break;

    try {
      await runJob(job);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[outbound] Job ${job.id} threw: ${message}`);

      await prisma.outboundJob.update({
        where: { id: job.id },
        data: {
          status: job.attemptCount >= job.maxAttempts ? "DEAD_LETTER" : "PENDING",
          nextAttemptAt: new Date(Date.now() + backoffMs(job.attemptCount)),
          lockedAt: null,
          lockedBy: null,
          lastError: message,
        },
      });
    }

    processed += 1;
  }

  return { processed };
}
