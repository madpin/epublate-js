/**
 * Shared PWA constants + tiny helpers.
 *
 * The service-worker registration in `src/main.tsx` and the
 * `useOfflineReady` hook both touch a single localStorage flag that
 * records whether Workbox has finished precaching the shell. Keeping
 * the key + read/write helpers here means the two callers can't
 * drift on the spelling.
 *
 * The flag is best-effort UX, not a security boundary. A wiped
 * localStorage simply makes the Settings card say "not yet cached"
 * until the next service-worker activation re-fires `onOfflineReady`.
 */

/** localStorage key set by `onOfflineReady` and read by Settings. */
export const OFFLINE_READY_KEY = "epublate-offline-ready";

/** Custom DOM event fired alongside the localStorage flag. */
export const OFFLINE_READY_EVENT = "epublate:offline-ready";

export function readOfflineReady(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(OFFLINE_READY_KEY) === "1";
}

export function writeOfflineReady(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(OFFLINE_READY_KEY, "1");
  // Same-tab listeners don't get `storage` events, so we dispatch a
  // bespoke event that `useOfflineReady` can subscribe to. The
  // Settings card flips from "Caching…" to "Cached" without a reload.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(OFFLINE_READY_EVENT));
  }
}
