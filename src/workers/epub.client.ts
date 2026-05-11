/**
 * Main-thread client for `epub.worker.ts`.
 *
 * Provides two operations — `unzipEpubBytes` and `zipEpubEntries` —
 * each with a transparent inline fallback when `Worker` isn't
 * available (Vitest's jsdom env, Node-bench shells, browsers that
 * disable module workers in private-browsing modes, …).
 *
 * The worker is constructed lazily and torn down after each call. ePub
 * intake and export are one-shot operations from the user's
 * perspective, so the savings from pooling a long-lived worker are
 * negligible compared with the simplicity gain of "spin up, do work,
 * spin down". If we ever build streaming pre-fetch (Tier 3.10) the
 * pool can grow incrementally.
 *
 * Worker URL pinned via `new URL(..., import.meta.url)` so Vite emits
 * a fingerprinted bundle for the worker chunk and the PWA precaches
 * it alongside the main bundle.
 */

import JSZip from "jszip";

const MIMETYPE_FILENAME = "mimetype";

/**
 * True if the runtime supports module workers. In jsdom-backed tests
 * `globalThis.Worker` is `undefined`; production browsers all have
 * it. We also defensively check the `URL` form we use to load the
 * worker — Vite rewrites this at build time but we don't want to
 * crash if a future bundler config breaks the rewrite.
 */
export function epubWorkerSupported(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof Blob !== "undefined"
  );
}

/**
 * Decompress an ePub byte buffer into its entry map.
 *
 * Prefers the worker, falls back to inline JSZip when workers are not
 * available. The result is structurally identical to the inline path
 * so callers can be agnostic.
 */
export async function unzipEpubBytes(
  bytes: ArrayBuffer | Uint8Array,
): Promise<Map<string, Uint8Array>> {
  const buffer = toArrayBuffer(bytes);
  if (!epubWorkerSupported()) {
    return unzipInline(buffer);
  }
  try {
    return await runUnzipInWorker(buffer);
  } catch (err) {
    // Worker construction failure (CSP, sandboxed iframe, browser bug
    // in private modes, …) must not break the app. Drop to the inline
    // path which always works.
    if (typeof console !== "undefined") {
      console.warn(
        "[epub.worker] falling back to inline unzip:",
        (err as Error)?.message ?? err,
      );
    }
    return unzipInline(buffer);
  }
}

/**
 * Build an ePub byte stream from an entries map.
 *
 * Entries with the literal name "mimetype" are always stored
 * uncompressed (ePub spec). Every other entry uses DEFLATE.
 *
 * The map's values may be `Uint8Array` (binary assets, pass-through
 * entries) or `string` (text we just generated — chapter XHTML, OPF).
 * JSZip handles both transparently.
 */
export async function zipEpubEntries(
  entries: Map<string, Uint8Array | string>,
): Promise<Uint8Array> {
  if (!epubWorkerSupported()) {
    return zipInline(entries);
  }
  try {
    return await runZipInWorker(entries);
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn(
        "[epub.worker] falling back to inline zip:",
        (err as Error)?.message ?? err,
      );
    }
    return zipInline(entries);
  }
}

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  // Copy so the caller's view isn't aliased / detached on transfer.
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/**
 * Inline (main-thread) JSZip path. Used directly in tests + as the
 * fallback when worker construction fails. Mirrors the worker's
 * implementation byte-for-byte so identity is preserved.
 */
async function unzipInline(
  bytes: ArrayBuffer,
): Promise<Map<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(bytes);
  const entries = new Map<string, Uint8Array>();
  await Promise.all(
    Object.values(zip.files).map(async (entry) => {
      if (entry.dir) return;
      entries.set(entry.name, await entry.async("uint8array"));
    }),
  );
  return entries;
}

async function zipInline(
  entries: Map<string, Uint8Array | string>,
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, value] of entries) {
    if (name === MIMETYPE_FILENAME) {
      zip.file(name, value, { compression: "STORE" });
    } else {
      zip.file(name, value);
    }
  }
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

/**
 * Worker request/response correlation by `id` is unnecessary because
 * we tear down the worker after each operation, but we still send an
 * id so the wire protocol is consistent and future poolers don't need
 * a v2.
 */
async function runUnzipInWorker(
  bytes: ArrayBuffer,
): Promise<Map<string, Uint8Array>> {
  const worker = makeEpubWorker();
  try {
    return await new Promise<Map<string, Uint8Array>>((resolve, reject) => {
      const id = makeRequestId();
      const cleanup = () => {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
      };
      worker.onmessage = (event: MessageEvent) => {
        const data = event.data as
          | { type: "unzipOk"; id: string; entries: Map<string, Uint8Array> }
          | { type: "error"; id: string; message: string };
        if (data?.id !== id) return;
        cleanup();
        if (data.type === "unzipOk") {
          resolve(data.entries);
        } else if (data.type === "error") {
          reject(new Error(data.message));
        } else {
          reject(new Error("epub worker returned unexpected reply"));
        }
      };
      worker.onerror = (event: ErrorEvent) => {
        cleanup();
        reject(event.error ?? new Error(event.message || "epub worker error"));
      };
      worker.onmessageerror = () => {
        cleanup();
        reject(new Error("epub worker message could not be deserialized"));
      };
      worker.postMessage({ type: "unzip", id, bytes }, [bytes]);
    });
  } finally {
    worker.terminate();
  }
}

async function runZipInWorker(
  entries: Map<string, Uint8Array | string>,
): Promise<Uint8Array> {
  const worker = makeEpubWorker();
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      const id = makeRequestId();
      const cleanup = () => {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
      };
      worker.onmessage = (event: MessageEvent) => {
        const data = event.data as
          | { type: "zipOk"; id: string; bytes: Uint8Array }
          | { type: "error"; id: string; message: string };
        if (data?.id !== id) return;
        cleanup();
        if (data.type === "zipOk") {
          resolve(data.bytes);
        } else if (data.type === "error") {
          reject(new Error(data.message));
        } else {
          reject(new Error("epub worker returned unexpected reply"));
        }
      };
      worker.onerror = (event: ErrorEvent) => {
        cleanup();
        reject(event.error ?? new Error(event.message || "epub worker error"));
      };
      worker.onmessageerror = () => {
        cleanup();
        reject(new Error("epub worker message could not be deserialized"));
      };
      // Transferring the Uint8Array values would orphan callers'
      // references mid-postMessage; copy semantics is the safer
      // default here. The big input was the ArrayBuffer in unzip,
      // not the entries map, so we don't pay much for this.
      worker.postMessage({ type: "zip", id, entries });
    });
  } finally {
    worker.terminate();
  }
}

function makeEpubWorker(): Worker {
  return new Worker(new URL("./epub.worker.ts", import.meta.url), {
    type: "module",
    name: "epub-worker",
  });
}

/**
 * Monotonic-ish id for in-flight worker requests. We only use it for
 * debug correlation today (the worker is single-shot per call), but
 * keeping it cheap and unique-enough means a future pool can multiplex.
 */
let nextRequestId = 0;
function makeRequestId(): string {
  nextRequestId = (nextRequestId + 1) | 0;
  return `req-${nextRequestId.toString(36)}`;
}
