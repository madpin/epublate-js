/**
 * Tests for the PWA install hook.
 *
 * We can't trigger a real `beforeinstallprompt` in JSDOM, so we
 * dispatch a synthetic Event with the `prompt` / `userChoice` shape
 * the hook expects. That exercises the same code path as a real
 * Chromium install — the hook never inspects anything browser-only.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { usePwaInstall } from "./usePwaInstall";

interface FakePromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  prompted: boolean;
}

function fakeBeforeInstallPrompt(
  outcome: "accepted" | "dismissed" = "accepted",
): FakePromptEvent {
  const ev = new Event("beforeinstallprompt") as FakePromptEvent;
  ev.prompted = false;
  ev.prompt = async () => {
    ev.prompted = true;
  };
  ev.userChoice = Promise.resolve({ outcome });
  return ev;
}

describe("usePwaInstall", () => {
  beforeEach(() => {
    // Each test starts from a clean install state.
    Object.defineProperty(window.navigator, "standalone", {
      configurable: true,
      value: undefined,
    });
  });

  it("starts unable to install with no installed flag", () => {
    const { result } = renderHook(() => usePwaInstall());
    expect(result.current.can_install).toBe(false);
    expect(result.current.installed).toBe(false);
    expect(result.current.running_as_installed_app).toBe(false);
  });

  it("captures beforeinstallprompt and exposes can_install", () => {
    const { result } = renderHook(() => usePwaInstall());
    const ev = fakeBeforeInstallPrompt();
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(result.current.can_install).toBe(true);
  });

  it("flips installed when appinstalled fires and clears the deferred prompt", () => {
    const { result } = renderHook(() => usePwaInstall());
    act(() => {
      window.dispatchEvent(fakeBeforeInstallPrompt());
    });
    expect(result.current.can_install).toBe(true);

    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    expect(result.current.installed).toBe(true);
    expect(result.current.can_install).toBe(false);
  });

  it("prompt() resolves to 'unsupported' before any beforeinstallprompt", async () => {
    const { result } = renderHook(() => usePwaInstall());
    let outcome: "accepted" | "dismissed" | "unsupported" = "unsupported";
    await act(async () => {
      outcome = await result.current.prompt();
    });
    expect(outcome).toBe("unsupported");
  });

  it("prompt() invokes the deferred event and reports the user choice", async () => {
    const { result } = renderHook(() => usePwaInstall());
    const ev = fakeBeforeInstallPrompt("accepted");
    act(() => {
      window.dispatchEvent(ev);
    });

    let outcome: "accepted" | "dismissed" | "unsupported" = "unsupported";
    await act(async () => {
      outcome = await result.current.prompt();
    });
    expect(ev.prompted).toBe(true);
    expect(outcome).toBe("accepted");
    // After a single shot the deferred prompt is dropped.
    expect(result.current.can_install).toBe(false);
    expect(result.current.installed).toBe(true);
  });

  it("prompt() reports 'dismissed' and keeps installed=false", async () => {
    const { result } = renderHook(() => usePwaInstall());
    const ev = fakeBeforeInstallPrompt("dismissed");
    act(() => {
      window.dispatchEvent(ev);
    });

    let outcome: "accepted" | "dismissed" | "unsupported" = "unsupported";
    await act(async () => {
      outcome = await result.current.prompt();
    });
    expect(outcome).toBe("dismissed");
    expect(result.current.can_install).toBe(false);
    expect(result.current.installed).toBe(false);
  });
});
