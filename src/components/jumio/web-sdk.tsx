"use client";

import { useEffect, useRef, useState } from "react";

import "@jumio/websdk/assets/style.css";

import type { JumioSdkDatacenter } from "@/lib/jumio/acquisition";

/**
 * Jumio's Web SDK, embedded in the page (§10).
 *
 * `<jumio-sdk>` is a custom element; importing the package registers it. The
 * import is dynamic because the module touches `document` as it evaluates, and
 * because it keeps the 2.2 MB SDK core out of the page's initial bundle.
 *
 * `onDone` fires when the driver reaches the end of the capture screens, and
 * that is all it means — the verification itself only moves on a callback plus
 * retrieval, so the caller sends the driver to a page that reads the database.
 */
export function JumioWebSdk({
  token,
  datacenter,
  locale = "en",
  onDone,
}: {
  token: string;
  datacenter: JumioSdkDatacenter;
  locale?: string;
  /** Must be stable — a new identity tears the SDK down and restarts the camera. */
  onDone: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const container = host.current;
    if (!container) return;

    let element: HTMLElement | undefined;

    import("@jumio/websdk").then(
      () => {
        element = document.createElement("jumio-sdk");
        element.setAttribute("dc", datacenter);
        element.setAttribute("token", token);
        element.setAttribute("locale", locale);
        element.style.cssText = "display:block;height:100%";
        // These events bubble and are composed, so one listener here catches
        // them wherever in the SDK's shadow tree they originate.
        element.addEventListener("workflow:success", onDone);
        element.addEventListener("workflow:failed", onDone);
        container.append(element);
        setStatus("ready");
      },
      (cause: unknown) => {
        console.error("[jumio] Web SDK failed to load:", cause);
        setStatus("error");
      },
    );

    // Removing the element runs the SDK's `disconnectedCallback`, which is what
    // stops the camera.
    return () => element?.remove();
  }, [token, datacenter, locale, onDone]);

  return (
    <div className="relative h-full w-full">
      {status !== "ready" && (
        <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted-foreground">
          {status === "loading"
            ? "Loading identity verification…"
            : "Identity verification could not be loaded. Please reload the page."}
        </p>
      )}
      <div ref={host} className="h-full w-full" />
    </div>
  );
}
