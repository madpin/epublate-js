import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  epubWorkerSupported,
  unzipEpubBytes,
  zipEpubEntries,
} from "@/workers/epub.client";

/**
 * jsdom doesn't expose `Worker`, so every test in this file exercises
 * the inline fallback path. The dedicated worker entry point
 * (`epub.worker.ts`) is byte-for-byte equivalent to the inline path
 * — both call `JSZip.loadAsync` / `generateAsync` with identical
 * options. If the fallback is correct, the worker is correct.
 *
 * The fallback path is what production browsers use whenever Worker
 * construction fails (CSP, private mode, etc.), so verifying it here
 * doubles as a regression test against future bundler / API drift.
 */
describe("epub.client (fallback path in jsdom)", () => {
  beforeEach(() => {
    expect(epubWorkerSupported()).toBe(false);
  });

  it("round-trips a single-entry zip", async () => {
    const entries = new Map<string, Uint8Array | string>([
      ["mimetype", "application/epub+zip"],
      ["foo.txt", "hello world"],
    ]);
    const bytes = await zipEpubEntries(entries);
    expect(bytes.byteLength).toBeGreaterThan(0);

    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const unpacked = await unzipEpubBytes(buf);
    expect(unpacked.size).toBe(2);
    expect(new TextDecoder().decode(unpacked.get("mimetype")!)).toBe(
      "application/epub+zip",
    );
    expect(new TextDecoder().decode(unpacked.get("foo.txt")!)).toBe("hello world");
  });

  it("uncompresses 'mimetype' specifically (ePub container spec)", async () => {
    // The literal "application/epub+zip" plain-text must appear at
    // bytes 38..62 of the file for `file(1)` / `epubcheck` /
    // OEBPS-2.0 readers to identify the archive. JSZip with
    // `compression: STORE` produces exactly that layout.
    const entries = new Map<string, Uint8Array | string>([
      ["mimetype", "application/epub+zip"],
      ["content.opf", "<?xml version='1.0'?><package/>"],
    ]);
    const bytes = await zipEpubEntries(entries);
    const window = new TextDecoder("latin1").decode(bytes.subarray(30, 80));
    expect(window).toContain("mimetype");
    expect(window).toContain("application/epub+zip");
  });

  it("accepts Uint8Array inputs to unzipEpubBytes", async () => {
    const entries = new Map<string, Uint8Array | string>([
      ["mimetype", "application/epub+zip"],
      ["a.bin", new Uint8Array([1, 2, 3, 4])],
    ]);
    const packed = await zipEpubEntries(entries);
    const unpacked = await unzipEpubBytes(packed);
    expect(unpacked.get("a.bin")).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("preserves binary entries verbatim", async () => {
    const bin = new Uint8Array(256);
    for (let i = 0; i < bin.length; i += 1) bin[i] = i;
    const entries = new Map<string, Uint8Array | string>([
      ["mimetype", "application/epub+zip"],
      ["cover.png", bin],
    ]);
    const packed = await zipEpubEntries(entries);
    const unpacked = await unzipEpubBytes(packed);
    expect(unpacked.get("cover.png")).toEqual(bin);
  });
});

describe("epub.client (worker path simulation)", () => {
  // We can't run a real Worker under jsdom, but we can stub
  // `globalThis.Worker` to confirm the client *attempts* the worker
  // path when one is present, and falls back cleanly when the
  // worker errors out.

  let originalWorker: typeof Worker | undefined;

  afterEach(() => {
    if (originalWorker === undefined) {
      delete (globalThis as Record<string, unknown>).Worker;
    } else {
      (globalThis as Record<string, unknown>).Worker = originalWorker;
    }
    originalWorker = undefined;
  });

  it("falls back to the inline path when worker construction throws", async () => {
    originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
    // Stub a Worker that throws synchronously on construction.
    (globalThis as Record<string, unknown>).Worker = class FakeWorker {
      constructor() {
        throw new Error("worker construction blocked in test");
      }
    };
    expect(epubWorkerSupported()).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const entries = new Map<string, Uint8Array | string>([
        ["mimetype", "application/epub+zip"],
        ["x.txt", "hi"],
      ]);
      const bytes = await zipEpubEntries(entries);
      expect(bytes.byteLength).toBeGreaterThan(0);
      // The fallback path is the one that produces these bytes.
      const buf = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const round = await unzipEpubBytes(buf);
      expect(round.size).toBe(2);
      // We expect at least one warning from each falling-back call.
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
