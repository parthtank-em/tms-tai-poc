"use client";

import { useEffect, useRef, useState } from "react";

import "@jumio/websdk/assets/style.css";
import "./web-sdk-theme.css";

import type { JumioSdkDatacenter } from "@/lib/jumio/acquisition";

/**
 * Copy overrides, keyed by locale and then by the SDK's own translation ids.
 *
 * Unlike a `<template>` override this still localizes: the strings replace the
 * SDK's defaults inside its translation layer rather than bypassing it. The
 * fallback is per key, not per override — a key omitted here, or a locale not
 * listed at all, keeps Jumio's original wording rather than the English below.
 */
const TRANSLATIONS: Record<string, Record<string, string>> = {
  en: {
    "instruction.start_verification": "Freight - Let's verify your identity",
    "cta.continue": "Next",
    "cta.back": "Previous",
  },
  es: {
    "instruction.start_verification": "Freight - Verifiquemos tu identidad",
    "cta.continue": "Siguiente",
    "cta.back": "Anterior",
  },
};

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

    // Read during the SDK's own `connectedCallback`, so it has to be in the
    // document before <jumio-sdk> is appended. The SDK insists on a <script>
    // with exactly this type and id, and on JSON that matches its schema; it
    // drops the whole override on any mismatch without logging to the console.
    const translations = document.createElement("script");
    translations.type = "application/json";
    translations.id = "jumio-translation";
    translations.textContent = JSON.stringify(TRANSLATIONS);
    container.append(translations);

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
    // stops the camera. The script goes with it so a re-run cannot leave a
    // second `#jumio-translation` behind for the SDK's lookup to find first.
    return () => {
      element?.remove();
      translations.remove();
    };
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
