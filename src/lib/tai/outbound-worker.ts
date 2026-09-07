import { randomUUID } from "node:crypto";

import {
  asAlerts,
  createActivityLog,
  createAlerts,
  resolveAlerts,
  updateStopTracking,
  updateTracking,
  type CallContext,
  type PublicApiAddShipmentAlert,
  type PublicApiShipmentAlert,
  type PublicApiShipmentTracking,
  type PublicApiShipmentTrackingUpdateShort,
  type TaiCallResult,
} from "./api-client";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Drains the outbound job queue (findings §4.1, §4.2).
 *
 * Inbound webhooks are at-most-once and TAI owns delivery; outbound is the
 * mirror image — **FreightID owns reliability here**. A TAI outage must delay a
 * push, never drop it, so nothing goes to TAI except through an `outbound_jobs`
 * row that survives restarts and is retried with backoff.
 */

export const ALERTS_CREATE = "ALERTS_CREATE";
export const ALERTS_RESOLVE = "ALERTS_RESOLVE";
export const TRACKING_UPDATE = "TRACKING_UPDATE";
export const STOP_TRACKING_UPDATE = "STOP_TRACKING_UPDATE";
export const ACTIVITY_LOG_CREATE = "ACTIVITY_LOG_CREATE";

/** Payload shape for STOP_TRACKING_UPDATE — the id rides in the URL, not the body. */
export type StopTrackingPayload = {
  shipmentStopId: number;
  body: PublicApiShipmentTrackingUpdateShort;
};

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
  eventId: string | null;
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
      eventId: true,
      shipmentId: true,
      payload: true,
      attemptCount: true,
      maxAttempts: true,
    },
  });
}

/** Copies whatever TAI returned onto the local alert row. */
async function applyAlertResponse(alertId: string, alertType: string, alerts: PublicApiShipmentAlert[]) {
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

async function dispatch(job: ClaimedJob, context: CallContext): Promise<TaiCallResult> {
  switch (job.operation) {
    case ALERTS_CREATE:
      return createAlerts(job.payload as unknown as PublicApiAddShipmentAlert, context);

    case ALERTS_RESOLVE:
      return resolveAlerts(job.payload as unknown as PublicApiAddShipmentAlert, context);

    case TRACKING_UPDATE:
      return updateTracking(job.payload as unknown as PublicApiShipmentTracking, context);

    case STOP_TRACKING_UPDATE: {
      const payload = job.payload as unknown as StopTrackingPayload;
      return updateStopTracking(payload.shipmentStopId, payload.body, context);
    }

    case ACTIVITY_LOG_CREATE:
      return createActivityLog(job.payload, context);

    default:
      return {
        ok: false,
        status: null,
        error: `Unknown outbound operation "${job.operation}".`,
        retryable: false,
      };
  }
}

/** Settles exactly the event this job carried — never any other in flight. */
async function settleEvent(
  eventId: string | null,
  data: Prisma.ShipmentEventUncheckedUpdateInput,
) {
  if (!eventId) return;
  await prisma.shipmentEvent.update({ where: { id: eventId }, data });
}

async function runJob(job: ClaimedJob): Promise<void> {
  const context: CallContext = {
    jobId: job.id,
    shipmentId: job.shipmentId ?? undefined,
    eventId: job.eventId ?? undefined,
    attempt: job.attemptCount,
  };

  const result = await dispatch(job, context);

  if (result.ok) {
    if (job.alertId && (job.operation === ALERTS_CREATE || job.operation === ALERTS_RESOLVE)) {
      const payload = job.payload as unknown as PublicApiAddShipmentAlert;
      await applyAlertResponse(job.alertId, payload.shipmentAlerts?.[0] ?? "", asAlerts(result.data));
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

    await settleEvent(job.eventId, {
      taiSyncStatus: "SYNCED",
      taiSyncedAt: new Date(),
      taiSyncError: null,
    });
    return;
  }

  const exhausted = !result.retryable || job.attemptCount >= job.maxAttempts;

  await prisma.outboundJob.update({
    where: { id: job.id },
    data: {
      // DEAD_LETTER means a human has to look. It stops the retry loop without
      // pretending the push reached TAI.
      status: exhausted ? "DEAD_LETTER" : "PENDING",
      nextAttemptAt: exhausted ? new Date() : new Date(Date.now() + backoffMs(job.attemptCount)),
      lockedAt: null,
      lockedBy: null,
      lastError: result.error,
      ...(exhausted ? { completedAt: new Date() } : {}),
    },
  });

  if (exhausted) {
    await settleEvent(job.eventId, { taiSyncStatus: "FAILED", taiSyncError: result.error });
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
