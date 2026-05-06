/**
 * Tests for the online-status hook.
 *
 * `navigator.onLine` is a writable getter in JSDOM (we override via
 * `Object.defineProperty`), and `online`/`offline` events on `window`
 * are plain DOM events we can dispatch directly.
 */

import { describe, expect, it, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useOnlineStatus } from "./useOnlineStatus";

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
}

describe("useOnlineStatus", () => {
  afterEach(() => {
    setOnLine(true);
  });

  it("reads the initial navigator.onLine value", () => {
    setOnLine(true);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
  });

  it("flips to false on offline event", () => {
    setOnLine(true);
    const { result } = renderHook(() => useOnlineStatus());
    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current).toBe(false);
  });

  it("flips back to true on online event", () => {
    setOnLine(false);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(false);
    act(() => {
      setOnLine(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current).toBe(true);
  });
});
