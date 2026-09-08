import { after } from "next/server";

import { verifyJumioCallback } from "@/lib/jumio/callback-auth";
import { getJumioConfig, JumioConfigError } from "@/lib/jumio/config";
import {
  applyCallbackStatus,
  recordJumioCallback,
  syncVerificationFromJumio,
} from "@/lib/jumio/verification";
import { prisma } from "@/lib/prisma";

import type { JumioCallbackPayload } from "@/lib/jumio/types";

/**
 * `POST /api/jumio/callback` — Jumio's workflow notification (§11).
 *
 * The shape mirrors the TAI webhook handler deliberately: authenticate, persist
 * what arrived, acknowledge, then do the real work in `after()` once the 200 is
 * on the wire.
 *
 * What the callback is *not* is the result. It says a workflow reached a state;
 * the decision, risk score and extracted data come from the Retrieval API,
 * which is why the retrieval call hangs off the end of this handler (§2.3).
 *
 * This route is intentionally outside the proxy's auth matcher — Jumio has no
 * FreightID session. Its own secret is the gate.
 */
export async function POST(request: Request): Promise<Response> {
  let config;

  try {
    config = getJumioConfig();
  } catch (error) {
    if (error instanceof JumioConfigError) {
      console.error(`[jumio] Callback rejected, integration not configured: ${error.message}`);
      return Response.json({ error: "Not configured" }, { status: 503 });
    }
    throw error;
  }

  const url = new URL(request.url);
  const { result, remoteIp, knownIp } = verifyJumioCallback(url, request.headers, config);

  if (result !== "AUTHORIZED") {
    // Nothing is persisted for a rejected delivery: the body is unauthenticated
    // and could be anyone's. Log the attempt and say as little as possible.
    console.warn(`[jumio] Rejected callback (${result}) from ${remoteIp ?? "unknown ip"}.`);
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!knownIp) {
    // Expected behind a tunnel in development; worth seeing in a log anywhere else.
    console.warn(`[jumio] Callback source ${remoteIp ?? "unknown"} is not a published Jumio IP.`);
  }

  let payload: JumioCallbackPayload;

  try {
    payload = (await request.json()) as JumioCallbackPayload;
  } catch {
    console.warn("[jumio] Callback body was not JSON.");
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const record = await recordJumioCallback(payload, { remoteIp });

  // A redelivery of something already stored, or a workflow we do not know:
  // ack and stop. Neither may touch a driver (§12, §21).
  if (!record.stored || !record.verificationId) {
    return Response.json({ received: true, processed: false });
  }

  const verificationId = record.verificationId;
  const status = payload.workflowExecution?.status ?? "";

  after(async () => {
    try {
      await applyCallbackStatus(verificationId, status);

      // Only a finished workflow has something to retrieve. The interim states
      // will each send their own callback.
      if (status.toUpperCase() === "PROCESSED") {
        await syncVerificationFromJumio(verificationId);
      }

      await markProcessed(verificationId, status);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      console.error(`[jumio] Post-callback processing failed for ${verificationId}: ${reason}`);
    }
  });

  return Response.json({ received: true, processed: true });
}

/** Stamp the stored callback rows for this workflow state as handled. */
async function markProcessed(verificationId: string, status: string): Promise<void> {
  await prisma.jumioCallbackEvent.updateMany({
    where: { verificationId, status, processedAt: null },
    data: { processedAt: new Date() },
  });
}
