"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-render the page when the verification actually changes.
 *
 * The driver lands back here from Jumio while the workflow is still processing,
 * so something has to notice the callback arriving. This polls the status
 * endpoint — the same JSON contract any other client would use — and refreshes
 * only when the status differs from what was rendered, rather than reloading on
 * a timer regardless.
 *
 * It gives up after a bounded number of attempts. A verification that has not
 * settled by then is waiting on Jumio, not on this page, and a tab left open
 * overnight should not keep polling.
 */
const INTERVAL_MS = 5_000;
const MAX_ATTEMPTS = 60;

export function ResultPoller({ driverId, status }: { driverId: string; status: string }) {
  const router = useRouter();

  useEffect(() => {
    let attempts = 0;
    let cancelled = false;

    const timer = setInterval(async () => {
      attempts += 1;

      if (attempts > MAX_ATTEMPTS) {
        clearInterval(timer);
        return;
      }

      try {
        const response = await fetch(
          `/api/jumio/status?driverId=${encodeURIComponent(driverId)}`,
          { cache: "no-store" },
        );

        if (!response.ok) return;

        const payload = (await response.json()) as { status?: string };

        if (!cancelled && payload.status && payload.status !== status) {
          clearInterval(timer);
          router.refresh();
        }
      } catch {
        // A failed poll is not worth surfacing — the next tick tries again.
      }
    }, INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [driverId, status, router]);

  return null;
}
