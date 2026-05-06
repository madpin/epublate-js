/**
 * `useOfflineReady` — exposes whether the service worker has reported
 * `onOfflineReady` at least once on this device.
 *
 * The flag is written by `src/main.tsx` into localStorage (and a
 * companion `epublate:offline-ready` event for same-tab listeners).
 * Settings reads it to decide between "Caching app for offline use…"
 * and "App cached for offline use" in the Install card.
 *
 * The flag is best-effort UX, not a security boundary: clearing
 * localStorage just makes the card say "not yet cached" until the
 * next service-worker activation re-fires the event. That matches
 * how Workbox actually behaves — the precache *is* present in Cache
 * Storage even if our flag was wiped.
 */

import * as React from "react";

import { OFFLINE_READY_EVENT, readOfflineReady } from "@/lib/pwa";

export function useOfflineReady(): boolean {
  const [ready, setReady] = React.useState<boolean>(readOfflineReady);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const onReady = (): void => setReady(true);
    const onStorage = (ev: StorageEvent): void => {
      if (ev.key === null || ev.key === "epublate-offline-ready") {
        setReady(readOfflineReady());
      }
    };
    window.addEventListener(OFFLINE_READY_EVENT, onReady);
    window.addEventListener("storage", onStorage);
    setReady(readOfflineReady());
    return () => {
      window.removeEventListener(OFFLINE_READY_EVENT, onReady);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return ready;
}
