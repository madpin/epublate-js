/**
 * Deterministic mock embedding provider.
 *
 * Same input ⇒ same vector, every time, no network. Used by:
 *
 * - Unit / integration tests (`?mock=1` demo mode lights this up too).
 * - The Inbox dedup phase, where we need stable vectors for snapshot
 *   tests against human-curated golden clusters.
 *
 * Strategy:
 *
 * - SHA-256 of the input is used as a seed for an `xorshift32` PRNG.
 * - The PRNG fills `dim` `Float32` slots; the resulting vector is then
 *   L2-normalized so cosine similarity behaves the way callers expect
 *   (range \[-1, 1\], "0" means "orthogonal", not "zero norm").
 *
 * The mock isn't intended to mimic real semantic structure — two
 * unrelated strings will land at orthogonal-ish vectors, which is
 * exactly what tests want.
 */

import {
  type EmbeddingProvider,
  type EmbeddingResult,
} from "./base";
import { sha256Hex } from "@/lib/hash";

const DEFAULT_DIM = 32;
const DEFAULT_MODEL = "mock-embed";
const DEFAULT_BATCH_SIZE = 64;

export interface MockEmbeddingProviderOptions {
  model?: string;
  dim?: number;
  batch_size?: number;
  /** Deterministic delay (ms) for UI demos that want a tiny pause. */
  delay_ms?: number;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model: string;
  readonly dim: number;
  readonly batch_size: number;
  private readonly delay_ms: number;

  constructor(options: MockEmbeddingProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.dim = options.dim ?? DEFAULT_DIM;
    this.batch_size = options.batch_size ?? DEFAULT_BATCH_SIZE;
    this.delay_ms = options.delay_ms ?? 0;
    if (!Number.isFinite(this.dim) || this.dim <= 0) {
      throw new Error(`MockEmbeddingProvider: invalid dim ${this.dim}`);
    }
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult> {
    if (this.delay_ms > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delay_ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    const vectors: Float32Array[] = [];
    let total_chars = 0;
    for (const text of texts) {
      vectors.push(await pseudoVector(text, this.dim));
      total_chars += text.length;
    }
    return {
      vectors,
      model: this.model,
      usage: { prompt_tokens: Math.max(0, Math.ceil(total_chars / 4)) },
      raw: { mock: true, count: texts.length, model: this.model, dim: this.dim },
    };
  }
}

/**
 * Deterministic pseudo-vector for `text` with `dim` slots.
 *
 * Exposed for tests and for the deterministic dedup oracle in
 * Phase 5: feeding the same string twice must produce bit-identical
 * vectors so snapshot tests don't drift across runs.
 */
export async function pseudoVector(
  text: string,
  dim: number,
): Promise<Float32Array> {
  const hex = await sha256Hex(text);
  // Seed an xorshift32 generator from the first 8 hex chars (32 bits).
  let state = parseInt(hex.slice(0, 8), 16) >>> 0 || 0xdeadbeef;
  const xs32 = (): number => {
    let x = state;
    x ^= (x << 13) >>> 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    state = x >>> 0;
    return state;
  };
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i += 1) {
    // Map u32 → [-1, 1).
    out[i] = (xs32() / 0x80000000) - 1;
  }
  // L2-normalize so cosine ≈ dot product downstream.
  let n2 = 0;
  for (let i = 0; i < dim; i += 1) n2 += out[i]! * out[i]!;
  const inv = n2 > 0 ? 1 / Math.sqrt(n2) : 0;
  if (inv > 0) {
    for (let i = 0; i < dim; i += 1) out[i] = out[i]! * inv;
  }
  return out;
}
