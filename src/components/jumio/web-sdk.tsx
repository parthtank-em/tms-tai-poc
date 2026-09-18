"use client";

import { useEffect, useRef, useState } from "react";

import "@jumio/websdk/assets/style.css";
import "./web-sdk-theme.css";

import type { JumioSdkDatacenter } from "@/lib/jumio/acquisition";

/**
 * Overrides the start screen's heading, which the SDK otherwise renders as
 * "Start Verification". Bare text, so it replaces the SDK's `<h1>` outright
 * rather than restyling it.
 *
 * Because this is literal content rather than a translation key, it stays
 * English at every `locale` — the localized route is a `#jumio-translation`
 * override of `instruction.start_verification`.
 */
const START_TITLE_TEMPLATE_ID = "jumio-start-title";
const START_TITLE_TEXT = "FreightId Driver Verification";

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

    // The SDK finds this with `document.querySelector` and clones its
    // `.content`, so it has to be a parsed <template> that is already in the
    // document when the start screen renders. `innerHTML` is what fills
    // `.content` — `textContent` would set the template's own child nodes, and
    // JSX children would do the same, leaving the SDK nothing to read.
    const titleTemplate = document.createElement("template");
    titleTemplate.id = START_TITLE_TEMPLATE_ID;
    titleTemplate.innerHTML = START_TITLE_TEXT;
    container.append(titleTemplate);

    import("@jumio/websdk").then(
      () => {
        element = document.createElement("jumio-sdk");
        element.setAttribute("dc", datacenter);
        element.setAttribute("token", token);
        element.setAttribute("locale", locale);
        element.setAttribute("show-language-selector", 'false');
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
    // stops the camera. The template goes with it so a re-run does not leave a
    // second `#jumio-start-title` behind for the query to pick up.
    return () => {
      element?.remove();
      titleTemplate.remove();
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
