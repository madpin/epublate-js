/**
 * `usePwaInstall` — reactive wrapper around the browser's PWA install
 * affordance.
 *
 * The browser dispatches `beforeinstallprompt` once it has decided
 * the page meets the install criteria (manifest, service worker,
 * engagement heuristics). The default browser UI is buried in the
 * omnibar; we capture the deferred prompt and expose a `prompt()`
 * function so the in-app sidebar / Settings card can offer a
 * discoverable "Install" button.
 *
 * The hook also tracks two installed states:
 *   - `installed: true` — `appinstalled` has fired in this tab, so we
 *     know the user just clicked through. Useful for hiding the
 *     install button immediately.
 *   - `running_as_installed_app: true` — the page is currently
 *     running inside the installed PWA (display-mode standalone
 *     and/or `navigator.standalone`). The button shouldn't render at
 *     all.
 *
 * Browsers that don't fire `beforeinstallprompt` at all (Safari
 * desktop, Firefox desktop) leave `canInstall = false` forever; the
 * UI should treat this as "the browser will show its own install
 * affordance, if any" and surface a generic instruction instead.
 */

import * as React from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface PwaInstallState {
  /** `true` when a deferred prompt is in hand. */
  can_install: boolean;
  /** `true` once `appinstalled` has fired in this tab. */
  installed: boolean;
  /**
   * `true` when this page is rendered inside an already-installed
   * PWA (standalone display mode). The install button should be
   * hidden entirely in this state.
   */
  running_as_installed_app: boolean;
  /**
   * Trigger the browser's install prompt. Resolves with the user's
   * choice. Calling this when `can_install` is `false` resolves to
   * `"unsupported"`.
   */
  prompt: () => Promise<"accepted" | "dismissed" | "unsupported">;
}

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") {
    try {
      if (window.matchMedia("(display-mode: standalone)").matches) {
        return true;
      }
    } catch {
      // ignore — older browsers throw on unknown queries.
    }
  }
  // iOS Safari uses the legacy `navigator.standalone` boolean.
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

export function usePwaInstall(): PwaInstallState {
  const [deferred, setDeferred] = React.useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const [installed, setInstalled] = React.useState(false);
  const [standalone, setStandalone] = React.useState<boolean>(detectStandalone);

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const onBeforeInstall = (ev: Event): void => {
      // Stash the event so the user can trigger the prompt from a
      // discoverable button later. Without this, the browser would
      // either show its own UI or drop the prompt entirely.
      ev.preventDefault();
      setDeferred(ev as BeforeInstallPromptEvent);
    };
    const onInstalled = (): void => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    // Track display-mode flips (uncommon, but possible — opening the
    // installed app from the dock is a separate session, but Chromium
    // can also re-fire the media-query listener mid-tab).
    let mql: MediaQueryList | null = null;
    const onModeChange = (): void => setStandalone(detectStandalone());
    if (typeof window.matchMedia === "function") {
      try {
        mql = window.matchMedia("(display-mode: standalone)");
        mql.addEventListener("change", onModeChange);
      } catch {
        mql = null;
      }
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      mql?.removeEventListener("change", onModeChange);
    };
  }, []);

  const prompt = React.useCallback(async (): Promise<
    "accepted" | "dismissed" | "unsupported"
  > => {
    const ev = deferred;
    if (!ev) return "unsupported";
    try {
      await ev.prompt();
    } catch {
      return "unsupported";
    }
    let outcome: "accepted" | "dismissed" = "dismissed";
    try {
      const choice = await ev.userChoice;
      outcome = choice.outcome;
    } catch {
      outcome = "dismissed";
    }
    // The deferred prompt is single-shot: drop it so the button
    // disables (Chrome will re-fire `beforeinstallprompt` later if
    // the user dismissed and re-engages).
    setDeferred(null);
    if (outcome === "accepted") setInstalled(true);
    return outcome;
  }, [deferred]);

  return {
    can_install: deferred !== null,
    installed,
    running_as_installed_app: standalone,
    prompt,
  };
}
