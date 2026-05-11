/**
 * Web Worker entry point for off-thread ePub parsing & assembly.
 *
 * Surface intentionally narrow: this worker is *not* an ePub library.
 * It only does the two CPU-heavy operations that block the UI today —
 * ZIP decompression and DEFLATE re-compression — and leaves XML / DOM
 * work on the main thread. `DOMParser` and `XMLSerializer` are not
 * reliably exposed inside a `Worker` scope across the browsers we
 * support, so the main thread retains ownership of every step that
 * touches a live `Document` / `Element`.
 *
 * Wire protocol:
 *
 *   ┌───────────────────────────────────┐
 *   │  unzip                            │
 *   │  → { type: "unzip", id, bytes }   │
 *   │  ← { type: "unzipOk", id, entries }
 *   │  ← { type: "error", id, message } │
 *   └───────────────────────────────────┘
 *   ┌───────────────────────────────────┐
 *   │  zip                              │
 *   │  → { type: "zip", id, entries }   │
 *   │  ← { type: "zipOk", id, bytes }   │
 *   │  ← { type: "error", id, message } │
 *   └───────────────────────────────────┘
 *
 * `entries` is a `Map<string, Uint8Array | string>`. The "mimetype"
 * key (if present) is always stored uncompressed (ePub container
 * spec); every other entry uses DEFLATE.
 *
 * Buffers are passed via `Transferable` so we don't copy multi-MB
 * payloads twice. Callers transfer the input `ArrayBuffer` on `unzip`
 * and the worker transfers the resulting `ArrayBuffer` on `zipOk`.
 */

import JSZip from "jszip";

const MIMETYPE_FILENAME = "mimetype";

type UnzipRequest = {
  type: "unzip";
  id: string;
  bytes: ArrayBuffer;
};

type ZipRequest = {
  type: "zip";
  id: string;
  entries: Map<string, Uint8Array | string>;
};

type WorkerRequest = UnzipRequest | ZipRequest;

interface UnzipReply {
  type: "unzipOk";
  id: string;
  entries: Map<string, Uint8Array>;
}

interface ZipReply {
  type: "zipOk";
  id: string;
  bytes: Uint8Array;
}

interface ErrorReply {
  type: "error";
  id: string;
  message: string;
  name: string;
}

export type WorkerReply = UnzipReply | ZipReply | ErrorReply;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    if (req.type === "unzip") {
      const entries = await unzipBytes(req.bytes);
      ctx.postMessage({ type: "unzipOk", id: req.id, entries } as UnzipReply);
      return;
    }
    if (req.type === "zip") {
      const bytes = await zipEntries(req.entries);
      // Transfer the underlying buffer to skip a copy on the way back.
      ctx.postMessage(
        { type: "zipOk", id: req.id, bytes } as ZipReply,
        [bytes.buffer as ArrayBuffer],
      );
      return;
    }
    throw new Error(`unknown worker request type: ${(req as { type?: string }).type}`);
  } catch (err) {
    const e = err as Error;
    ctx.postMessage(
      {
        type: "error",
        id: req.id,
        message: e?.message ?? String(err),
        name: e?.name ?? "Error",
      } as ErrorReply,
    );
  }
};

async function unzipBytes(bytes: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(bytes);
  const entries = new Map<string, Uint8Array>();
  await Promise.all(
    Object.values(zip.files).map(async (entry) => {
      if (entry.dir) return;
      const data = await entry.async("uint8array");
      entries.set(entry.name, data);
    }),
  );
  return entries;
}

async function zipEntries(
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
