/**
 * `useOnlineStatus` — reactive `navigator.onLine` snapshot.
 *
 * Used to decorate the AppShell with an "offline" badge and to soften
 * the "Translate batch" button's failure mode when the network is
 * gone. The browser fires `online`/`offline` events on the `window`
 * object as connectivity flips, so we just subscribe and re-render.
 *
 * Note: `navigator.onLine` is a heuristic. A `true` reading does not
 * guarantee that the configured LLM endpoint is reachable (CORS,
 * DNS, captive portals all confound it). A `false` reading is much
 * more reliable — when it's set we know calls *will* fail, so we use
 * it to surface a friendlier explanation than the raw fetch error.
 */

import * as React from "react";

function readOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = React.useState<boolean>(readOnline);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const onOnline = (): void => setOnline(true);
    const onOffline = (): void => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    // Also re-read on mount in case the value changed between
    // module load and this effect running.
    setOnline(readOnline());
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return online;
}
