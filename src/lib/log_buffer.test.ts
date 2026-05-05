/**
 * Tests for the in-memory console-log buffer.
 *
 * The buffer is a global ring; tests reset it before each case and
 * assert listener notifications + buffer content shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearLogBuffer,
  getLogBuffer,
  installConsoleLogBuffer,
  pushLogEntry,
  subscribeLogBuffer,
  type LogEntry,
} from "./log_buffer";

describe("log_buffer", () => {
  beforeEach(() => {
    clearLogBuffer();
  });
  afterEach(() => {
    clearLogBuffer();
  });

  it("retains pushed entries in insertion order", () => {
    pushLogEntry("info", "first");
    pushLogEntry("warn", "second");
    pushLogEntry("error", "third");

    const buf = getLogBuffer();
    expect(buf.map((e) => e.message)).toEqual(["first", "second", "third"]);
    expect(buf.map((e) => e.level)).toEqual(["info", "warn", "error"]);
  });

  it("notifies subscribers and survives unsubscribe", () => {
    const seen: LogEntry[] = [];
    const unsub = subscribeLogBuffer((e) => seen.push(e));
    pushLogEntry("info", "alpha");
    pushLogEntry("warn", "beta");
    unsub();
    pushLogEntry("error", "gamma");

    expect(seen.map((e) => e.message)).toEqual(["alpha", "beta"]);
    expect(getLogBuffer().map((e) => e.message)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("captures console.log when installed", () => {
    const original = console.log;
    const spy = vi.fn();
    console.log = spy;
    try {
      installConsoleLogBuffer();
      console.log("hello", { x: 1 });
      expect(spy).toHaveBeenCalledWith("hello", { x: 1 });
      const last = getLogBuffer().at(-1);
      expect(last?.level).toBe("log");
      expect(last?.message).toBe('hello {"x":1}');
    } finally {
      console.log = original;
    }
  });
});
