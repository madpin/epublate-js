/**
 * Tests for the offline-ready hook.
 *
 * Drives the hook by writing the localStorage flag and dispatching
 * the same `epublate:offline-ready` event that `src/main.tsx` fires
 * inside `onOfflineReady`.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  OFFLINE_READY_EVENT,
  OFFLINE_READY_KEY,
  writeOfflineReady,
} from "@/lib/pwa";
import { useOfflineReady } from "./useOfflineReady";

describe("useOfflineReady", () => {
  beforeEach(() => {
    localStorage.removeItem(OFFLINE_READY_KEY);
  });

  it("reads the initial localStorage value", () => {
    localStorage.setItem(OFFLINE_READY_KEY, "1");
    const { result } = renderHook(() => useOfflineReady());
    expect(result.current).toBe(true);
  });

  it("flips to true on the same-tab event", () => {
    const { result } = renderHook(() => useOfflineReady());
    expect(result.current).toBe(false);
    act(() => {
      writeOfflineReady();
    });
    expect(result.current).toBe(true);
  });

  it("flips on a cross-tab storage event", () => {
    const { result } = renderHook(() => useOfflineReady());
    expect(result.current).toBe(false);
    act(() => {
      localStorage.setItem(OFFLINE_READY_KEY, "1");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: OFFLINE_READY_KEY,
          newValue: "1",
        }),
      );
    });
    expect(result.current).toBe(true);
  });

  it("ignores the custom event before localStorage is set", () => {
    const { result } = renderHook(() => useOfflineReady());
    act(() => {
      window.dispatchEvent(new Event(OFFLINE_READY_EVENT));
    });
    expect(result.current).toBe(false);
  });
});
