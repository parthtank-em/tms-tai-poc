import { after } from "next/server";

import { clientIp, scrubHeaders, verifyWebhookAuth } from "./auth";
import { processWebhookEvent } from "./process";

import type { Prisma } from "@/generated/prisma/client";
import type { WebhookType } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

/**
 * Shared inbound webhook entry point (findings §3).
 *
 * The delivery contract TAI gives us drives every decision here:
 *
 * - **At-most-once, never retried.** Whatever arrives is persisted before it is
 *   understood. A payload we cannot parse is still stored and still acked 200 —
 *   returning an error would simply destroy the event, because TAI will not
 *   send it again.
 * - **Respond fast.** Their HttpClient gives up around 100s, but the guidance is
 *   to ack immediately and work asynchronously. Parsing and upserts happen in
 *   `after()`, once the 200 is on the wire.
 * - **401 on a bad credential.** The one case that is deliberately *not* 200:
 *   the doc asks for it, and TAI logs it, so a wrong secret is visible during
 *   testing rather than silently accepted.
 */

/** Guards against an unbounded row in `webhook_events`. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function receiveTaiWebhook(request: Request, type: WebhookType): Promise<Response> {
  const headers = scrubHeaders(request.headers);
  const remoteIp = clientIp(request.headers);
  const authResult = verifyWebhookAuth(request.headers.get("authorization"));

  if (authResult !== "AUTHORIZED") {
    // Log the rejection too. TAI never re-sends, so a credential mistake is
    // permanent data loss and we want to see it happening.
    await prisma.webhookEvent.create({
      data: {
        type,
        rawPayload: {},
        headers,
        remoteIp,
        authResult,
        processingStatus: "SKIPPED",
        responseStatus: 401,
        error: `Rejected inbound delivery: ${authResult}`,
      },
    });

    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const bodyText = await request.text();

  if (Buffer.byteLength(bodyText, "utf8") > MAX_BODY_BYTES) {
    await prisma.webhookEvent.create({
      data: {
        type,
        rawPayload: { _truncated: true, _bytes: Buffer.byteLength(bodyText, "utf8") },
        headers,
        remoteIp,
        authResult,
        processingStatus: "SKIPPED",
        responseStatus: 200,
        error: `Body exceeds ${MAX_BODY_BYTES} bytes.`,
      },
    });

    return Response.json({ received: true, processed: false }, { status: 200 });
  }

  let payload: Prisma.InputJsonValue;
  let parseError: string | null = null;

  try {
    payload = JSON.parse(bodyText) as Prisma.InputJsonValue;
  } catch (error) {
    // Keep the bytes verbatim so the delivery can be replayed by hand.
    payload = { _unparsed: bodyText };
    parseError = error instanceof Error ? error.message : String(error);
  }

  const event = await prisma.webhookEvent.create({
    data: {
      type,
      rawPayload: payload,
      headers,
      remoteIp,
      authResult,
      processingStatus: parseError ? "SKIPPED" : "PENDING",
      responseStatus: 200,
      error: parseError,
    },
    select: { id: true },
  });

  if (!parseError) {
    // Runs after the response is flushed.
    after(async () => {
      await processWebhookEvent(event.id);
    });
  }

  return Response.json(
    { received: true, webhookEventId: event.id, processed: !parseError },
    { status: 200 },
  );
}
