/**
 * Provider-neutral embedding interface (sibling to `LLMProvider`).
 *
 * Mirrors the shape of `@/llm/base` so the rest of the codebase can
 * swap concrete providers (OpenAI-compatible, local `@xenova/transformers`,
 * deterministic mock) without leaking provider-specific types.
 *
 * Higher layers (Lore-Book retrieval, cross-chapter context, proposed-
 * entry hints) call `embed(texts)` to obtain `Float32Array` vectors and
 * persist them in the per-project / per-Lore-Book Dexie `embeddings`
 * table. Cosine similarity is computed in JS on top of the raw vectors;
 * the provider is free of any retrieval logic.
 *
 * Audit ledger reuses the existing `llm_calls` table by tagging rows
 * with `purpose = "embedding"`. See {@link PURPOSE_EMBEDDING}.
 */

/** Reserved purpose tag for `llm_calls` rows produced by embedding providers. */
export const PURPOSE_EMBEDDING = "embedding";

export interface EmbeddingUsage {
  /**
   * Heuristic prompt-token count. OpenAI-compatible endpoints return
   * an exact value; the local provider falls back to
   * `ceil(input_chars / 4)` to keep cost surfacing comparable across
   * providers (the local cost is always 0 USD).
   */
  prompt_tokens: number;
}

export interface EmbeddingResult {
  /**
   * One `Float32Array` per input text, in input order. Length must be
   * exactly `dim` (the provider's declared dimensionality).
   */
  vectors: Float32Array[];
  /** Provider-reported model id, mirrored from the `model` field. */
  model: string;
  /** Per-call usage. `null` if the provider can't estimate it. */
  usage: EmbeddingUsage | null;
  /** Raw response payload for the audit log. */
  raw: unknown;
  /**
   * Wall-clock duration of the call (including any internal batching /
   * retries), in milliseconds. `null` when the provider didn't measure.
   * Used by the LLM Activity screen to surface slow embedding calls.
   */
  duration_ms?: number | null;
}

export interface EmbeddingProvider {
  /** Provider-shape identifier surfaced in the audit table. */
  readonly name: string;
  /** Concrete model id, e.g. `text-embedding-3-small` or `Xenova/multilingual-e5-small`. */
  readonly model: string;
  /** Vector dimensionality, e.g. 1536 (OpenAI small) or 384 (multilingual-e5-small). */
  readonly dim: number;
  /** Default batch size; callers may chunk further. */
  readonly batch_size: number;
  /**
   * Embed a batch of texts. Implementations MUST chunk internally if
   * the input exceeds `batch_size`; callers can pass the whole list.
   * `signal` plumbs through to `fetch` / async cancellation.
   */
  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult>;
}

/** Errors the retrieval layer knows how to react to. */
export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export class EmbeddingHttpError extends EmbeddingError {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "EmbeddingHttpError";
    this.status = status;
  }
}

export class EmbeddingRateLimitError extends EmbeddingError {
  retry_after_seconds: number | null;
  reason: string;
  constructor(
    message: string,
    options: { retry_after_seconds?: number | null; reason?: string } = {},
  ) {
    super(message);
    this.name = "EmbeddingRateLimitError";
    this.retry_after_seconds = options.retry_after_seconds ?? null;
    this.reason = options.reason ?? message;
  }
}

export class EmbeddingConfigurationError extends EmbeddingError {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingConfigurationError";
  }
}

export class EmbeddingConsentRequiredError extends EmbeddingError {
  /** Bytes the curator is being asked to download. */
  approximate_bytes: number;
  /** Source URL or repository (for the consent dialog copy). */
  source: string;
  constructor(
    message: string,
    options: { approximate_bytes: number; source: string },
  ) {
    super(message);
    this.name = "EmbeddingConsentRequiredError";
    this.approximate_bytes = options.approximate_bytes;
    this.source = options.source;
  }
}

/**
 * Encode a `Float32Array` for storage in IndexedDB.
 *
 * Stored as `Uint8Array` (over a fresh `ArrayBuffer`) because some
 * structured-clone backends (`fake-indexeddb` in particular) detach
 * the underlying buffer when it's shared with a `Float32Array` view,
 * which surfaces later as `TypeError: ArrayBuffer is detached`. A
 * standalone `Uint8Array` clones cleanly.
 */
export function packFloat32(vec: Float32Array): Uint8Array {
  const out = new Uint8Array(vec.byteLength);
  out.set(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
  return out;
}

/** Inverse of {@link packFloat32}. Returns a fresh `Float32Array`. */
export function unpackFloat32(packed: Uint8Array): Float32Array {
  const buf = new ArrayBuffer(packed.byteLength);
  new Uint8Array(buf).set(packed);
  return new Float32Array(buf);
}

/**
 * Cosine similarity between two same-dim `Float32Array` vectors.
 *
 * Returns 0 for zero-norm vectors so the caller doesn't have to guard
 * against `NaN`. The retrieval layer treats "0" as "no signal" which
 * is the right interpretation for a degenerate vector.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosine: dim mismatch (${a.length} vs ${b.length}); both vectors must be from the same model`,
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
