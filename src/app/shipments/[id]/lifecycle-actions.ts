"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { requireSession } from "@/lib/auth/guard";
import {
  assignDriver,
  capturePod,
  recordStopArrival,
  recordStopDeparture,
  setShipmentStatus,
  verifyDriverIdentity,
  type LifecycleResult,
} from "@/lib/tai/lifecycle";
import { drainOutboundJobs } from "@/lib/tai/outbound-worker";

export type ActionState = { error: string | null; notice: string | null };

/**
 * Pushes freshly queued jobs at TAI without making the operator wait. Failure
 * here is not failure of the action — the job row is durable and the worker
 * retries it.
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

async function run(
  shipmentId: string,
  notice: string,
  work: () => Promise<LifecycleResult>,
): Promise<ActionState> {
  await requireSession();

  const result = await work();
  if (!result.ok) return { error: result.error, notice: null };

  kickWorker();
  revalidatePath(`/shipments/${shipmentId}`);

  return { error: null, notice };
}

export async function assignDriverAction(formData: FormData): Promise<ActionState> {
  const shipmentId = String(formData.get("shipmentId") ?? "");
  const name = String(formData.get("driverName") ?? "");
  const phone = String(formData.get("driverPhone") ?? "");

  return run(shipmentId, "Driver assigned. Not sent to TAI — held pending §5.", () =>
    assignDriver(shipmentId, { name, phone }),
  );
}

export async function verifyDriverAction(formData: FormData): Promise<ActionState> {
  const shipmentId = String(formData.get("shipmentId") ?? "");

  return run(shipmentId, "Identity verified and queued for TAI.", () =>
    verifyDriverIdentity(shipmentId),
  );
}

export async function stopArrivalAction(formData: FormData): Promise<ActionState> {
  const shipmentId = String(formData.get("shipmentId") ?? "");
  const stopId = String(formData.get("stopId") ?? "");

  return run(shipmentId, "Arrival recorded and queued for TAI.", () =>
    recordStopArrival(shipmentId, stopId),
  );
}

export async function stopDepartureAction(formData: FormData): Promise<ActionState> {
  const shipmentId = String(formData.get("shipmentId") ?? "");
  const stopId = String(formData.get("stopId") ?? "");

  return run(shipmentId, "Departure recorded and queued for TAI.", () =>
    recordStopDeparture(shipmentId, stopId),
  );
}

export async function capturePodAction(formData: FormData): Promise<ActionState> {
  const shipmentId = String(formData.get("shipmentId") ?? "");
  const stopId = String(formData.get("stopId") ?? "");
  const signedBy = String(formData.get("signedBy") ?? "");

  return run(shipmentId, "POD captured and queued for TAI.", () =>
    capturePod(shipmentId, stopId, signedBy),
  );
}

export async function setStatusAction(formData: FormData): Promise<ActionState> {
  const shipmentId = String(formData.get("shipmentId") ?? "");
  const status = String(formData.get("status") ?? "");

  if (status !== "IN_TRANSIT" && status !== "DELIVERED") {
    return { error: "Unsupported status.", notice: null };
  }

  return run(shipmentId, "Status updated and queued for TAI.", () =>
    setShipmentStatus(shipmentId, status),
  );
}
