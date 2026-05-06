/**
 * Embedding prefetcher — overlaps `embed()` calls with translator
 * pool traffic.
 *
 * The pipeline used to embed each segment one-at-a-time, blocking
 * the LLM chat call on the embedding round-trip. For a 5 000-segment
 * book that meant 5 000 separate `POST /v1/embeddings` requests, each
 * one serializing a translation. The prefetcher collapses that into
 * roughly `pending / batch_size` *batched* calls (≈ 78 for the same
 * book at the OpenAI default of 64) and runs them in parallel with
 * the translator workers.
 *
 * Coordination contract:
 *
 * - **Synchronous reservation.** Both {@link warmCache} and
 *   {@link getEmbedding} reserve an in-flight placeholder *before*
 *   any `await`, so any racing worker that asks for the same segment
 *   joins the same promise instead of firing a redundant singleton.
 * - **IDB cache short-circuit.** Once reserved, every segment is
 *   checked against the persisted vector store. Hits resolve the
 *   placeholder immediately and don't dispatch a batch.
 * - **Bulk dispatch.** Remaining reservations are split into
 *   `batch_size`-sized slices and dispatched on a worker pool of
 *   `parallel_batches` (default `4`). The provider's own
 *   `EmbeddingResult.duration_ms` is recorded on the audit row.
 * - **Failure isolation.** On a provider error every waiter resolves
 *   to `null` (the pipeline already treats null as "fall back to the
 *   legacy flat merge"), and an `embedding.failed` event is appended.
 */

import { newId } from "@/lib/id";
import { openProjectDb } from "@/db/dexie";
import {
  bulkUpsertEmbeddings,
  getEmbedding,
  type UpsertEmbeddingInput,
} from "@/db/repo/embeddings";
import { insertLlmCall } from "@/db/repo/llm_calls";
import { type SegmentRow } from "@/db/schema";
import {
  PURPOSE_EMBEDDING,
  type EmbeddingProvider,
  EmbeddingError,
  unpackFloat32,
} from "@/llm/embeddings/base";
import { estimateCost } from "@/llm/pricing";
import { type Segment } from "@/formats/epub/types";

export interface EmbeddingPrefetcherOptions {
  /**
   * Number of bulk `embed()` calls in flight at once. Defaults to 4.
   * Each call already pulls `provider.batch_size` segments, so 4
   * concurrent calls embed `4 * batch_size` segments per network
   * wave (typically 256 for OpenAI). Bumped higher for local Ollama
   * / on-device Xenova where there's no rate-limit.
   */
  parallel_batches?: number;
}

interface Reservation {
  segment_id: string;
  source_text: string;
  resolve: (v: Float32Array | null) => void;
}

const DEFAULT_PARALLEL = 4;

export class EmbeddingPrefetcher {
  readonly project_id: string;
  readonly provider: EmbeddingProvider;
  private readonly signal: AbortSignal | undefined;
  private readonly in_flight: Map<string, Promise<Float32Array | null>>;

  constructor(
    project_id: string,
    provider: EmbeddingProvider,
    signal?: AbortSignal,
  ) {
    this.project_id = project_id;
    this.provider = provider;
    this.signal = signal;
    this.in_flight = new Map();
  }

  /**
   * Bulk-embed every segment that isn't already cached or in-flight,
   * in parallel batches of `provider.batch_size`. Reservations are
   * registered synchronously before any await so translator workers
   * that race ahead of the prefetcher pick up the shared promise
   * instead of firing redundant singleton embeds.
   */
  async warmCache(
    segments: readonly SegmentRow[],
    options: EmbeddingPrefetcherOptions = {},
  ): Promise<void> {
    // Phase 1 (synchronous): reserve a placeholder promise for every
    // segment that isn't already in flight. The map mutation must
    // happen before the first await so a worker that calls
    // `getEmbedding` immediately after `warmCache(...)` (without
    // awaiting it) sees the in-flight entries.
    const reservations: Reservation[] = [];
    for (const seg of segments) {
      if (!seg.source_text || !seg.source_text.trim()) continue;
      if (this.in_flight.has(seg.id)) continue;
      reservations.push(this.reserve(seg.id, seg.source_text));
    }
    if (!reservations.length) return;

    // Phase 2: short-circuit any reservation whose vector is already
    // in IDB. We resolve the placeholder right away so workers stop
    // waiting; the failed lookup is non-fatal — we just fall through
    // to the batch-dispatch path.
    const todo: Reservation[] = [];
    for (const r of reservations) {
      let hit = false;
      try {
        const cached = await getEmbedding(
          "project",
          this.project_id,
          "segment",
          r.segment_id,
          this.provider.model,
        );
        if (cached) {
          const vec = unpackFloat32(cached.vector);
          r.resolve(vec);
          this.in_flight.delete(r.segment_id);
          hit = true;
        }
      } catch {
        // Fall through to the batch path.
      }
      if (!hit) todo.push(r);
    }
    if (!todo.length) return;

    // Phase 3: batch-dispatch on a `parallel_batches` worker pool.
    const batch_size = Math.max(1, this.provider.batch_size);
    const batches: Reservation[][] = [];
    for (let i = 0; i < todo.length; i += batch_size) {
      batches.push(todo.slice(i, i + batch_size));
    }
    const parallel = Math.max(
      1,
      options.parallel_batches ?? DEFAULT_PARALLEL,
    );

    let cursor = 0;
    const dispatch = async (): Promise<void> => {
      while (true) {
        if (this.signal?.aborted) {
          // Bail out gracefully — resolve any unsent reservations to
          // null so waiters don't hang forever.
          this.cancelRemaining(batches.slice(cursor));
          return;
        }
        const i = cursor++;
        if (i >= batches.length) return;
        await this.runBatch(batches[i]!, i);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(parallel, batches.length) }, () =>
        dispatch(),
      ),
    );
  }

  /**
   * Resolve a single segment's vector. The pipeline calls this
   * exactly once per `translateSegment` invocation when a Lore-Book
   * retrieval, `relevant` context mode, or proposed-hint lookup is
   * active.
   */
  async getEmbedding(segment: Segment): Promise<Float32Array | null> {
    if (!segment.source_text || !segment.source_text.trim()) {
      return null;
    }

    // 1. Join an existing in-flight reservation (synchronous check
    //    so concurrent callers always share the same promise).
    const existing = this.in_flight.get(segment.id);
    if (existing) return existing;

    // 2. Reserve a placeholder *before* any await — this wins races
    //    against a peer worker (or a `warmCache` call) that asks for
    //    the same segment a moment later.
    const r = this.reserve(segment.id, segment.source_text);

    // 3. IDB cache hit fast-path. Resolves the placeholder right
    //    away — no provider round-trip.
    try {
      const cached = await getEmbedding(
        "project",
        this.project_id,
        "segment",
        segment.id,
        this.provider.model,
      );
      if (cached) {
        const vec = unpackFloat32(cached.vector);
        r.resolve(vec);
        this.in_flight.delete(segment.id);
        return vec;
      }
    } catch {
      // IDB read errors are rare and non-fatal; fall through.
    }

    // 4. Singleton embed fallback. We persist + audit the result and
    //    resolve the placeholder so any peer that joined our promise
    //    gets the same vector.
    return this.embedSingleton(r);
  }

  /**
   * Synchronously register an in-flight reservation. Returns the
   * resolver so the caller can settle it once the embedding lands.
   */
  private reserve(segment_id: string, source_text: string): Reservation {
    let resolve!: (v: Float32Array | null) => void;
    const promise = new Promise<Float32Array | null>((res) => {
      resolve = res;
    });
    this.in_flight.set(segment_id, promise);
    return { segment_id, source_text, resolve };
  }

  private async runBatch(
    items: Reservation[],
    batch_idx: number,
  ): Promise<void> {
    if (!items.length) return;
    const finalize = (vectors: Array<Float32Array | null>): void => {
      for (let i = 0; i < items.length; i += 1) {
        const v = vectors[i] ?? null;
        items[i]!.resolve(v);
        this.in_flight.delete(items[i]!.segment_id);
      }
    };
    try {
      const result = await this.provider.embed(
        items.map((it) => it.source_text),
        this.signal,
      );
      const inserts: UpsertEmbeddingInput[] = [];
      const settled: Array<Float32Array | null> = new Array(items.length);
      for (let i = 0; i < items.length; i += 1) {
        const vec = result.vectors[i] ?? null;
        settled[i] = vec;
        if (vec) {
          inserts.push({
            scope: "segment",
            ref_id: items[i]!.segment_id,
            model: this.provider.model,
            vector: vec,
          });
        }
      }
      if (inserts.length) {
        try {
          await bulkUpsertEmbeddings("project", this.project_id, inserts);
        } catch {
          // Persistence failures don't sink the in-flight resolves;
          // workers still get the vectors from memory and translate.
        }
      }
      // Audit row covers the whole batch — same shape the embedding
      // pass writes so the LLM Activity screen can roll up consistently.
      const prompt_tokens = result.usage?.prompt_tokens ?? 0;
      const cost_usd = estimateCost(this.provider.model, prompt_tokens, 0);
      try {
        await insertLlmCall(this.project_id, {
          id: newId(),
          project_id: this.project_id,
          segment_id: null,
          purpose: PURPOSE_EMBEDDING,
          model: this.provider.model,
          prompt_tokens,
          completion_tokens: 0,
          cost_usd,
          cache_hit: false,
          cache_key: null,
          request_json: JSON.stringify({
            provider: this.provider.name,
            model: this.provider.model,
            scope: "segment",
            kind: "prefetch_batch",
            batch_idx,
            input_count: items.length,
            segment_ids: items.map((it) => it.segment_id),
          }),
          response_json: JSON.stringify({
            vectors: inserts.length,
            dim: result.vectors[0]?.length ?? null,
            model: result.model,
            usage: result.usage,
            duration_ms: result.duration_ms ?? null,
            raw: result.raw,
          }),
          duration_ms: result.duration_ms ?? null,
        });
      } catch {
        // Audit log failure is best-effort.
      }
      finalize(settled);
    } catch (err) {
      finalize(items.map(() => null));
      try {
        const db = openProjectDb(this.project_id);
        await db.events.add({
          project_id: this.project_id,
          ts: Date.now(),
          kind: "embedding.failed",
          payload_json: JSON.stringify({
            scope: "segment",
            model: this.provider.model,
            kind: "prefetch_batch",
            batch_idx,
            input_count: items.length,
            error: err instanceof Error ? err.message : String(err),
            cause: err instanceof EmbeddingError ? "provider" : "unknown",
          }),
        });
      } catch {
        // event log is best-effort
      }
    }
  }

  /**
   * Resolve an existing reservation with a fresh singleton embed.
   * Mirrors {@link runBatch}'s persist + audit path so a worker that
   * raced ahead of the prefetcher entirely still produces a complete
   * audit row (and the same `embedding` purpose tag).
   */
  private async embedSingleton(r: Reservation): Promise<Float32Array | null> {
    try {
      const result = await this.provider.embed([r.source_text], this.signal);
      const vec = result.vectors[0] ?? null;
      if (!vec) {
        r.resolve(null);
        this.in_flight.delete(r.segment_id);
        return null;
      }
      const prompt_tokens = result.usage?.prompt_tokens ?? 0;
      const cost_usd = estimateCost(this.provider.model, prompt_tokens, 0);
      try {
        await bulkUpsertEmbeddings("project", this.project_id, [
          {
            scope: "segment",
            ref_id: r.segment_id,
            model: this.provider.model,
            vector: vec,
          },
        ]);
      } catch {
        // The next translateSegment call will simply re-embed.
      }
      try {
        await insertLlmCall(this.project_id, {
          id: newId(),
          project_id: this.project_id,
          segment_id: r.segment_id,
          purpose: PURPOSE_EMBEDDING,
          model: this.provider.model,
          prompt_tokens,
          completion_tokens: 0,
          cost_usd,
          cache_hit: false,
          cache_key: null,
          request_json: JSON.stringify({
            provider: this.provider.name,
            model: this.provider.model,
            scope: "segment",
            kind: "singleton",
            segment_id: r.segment_id,
          }),
          response_json: JSON.stringify({
            vectors: 1,
            dim: vec.length,
            model: result.model,
            usage: result.usage,
            duration_ms: result.duration_ms ?? null,
            raw: result.raw,
          }),
          duration_ms: result.duration_ms ?? null,
        });
      } catch {
        /* audit best-effort */
      }
      r.resolve(vec);
      this.in_flight.delete(r.segment_id);
      return vec;
    } catch (err) {
      try {
        const db = openProjectDb(this.project_id);
        await db.events.add({
          project_id: this.project_id,
          ts: Date.now(),
          kind: "embedding.failed",
          payload_json: JSON.stringify({
            segment_id: r.segment_id,
            scope: "segment",
            model: this.provider.model,
            kind: "singleton",
            error: err instanceof Error ? err.message : String(err),
            cause: err instanceof EmbeddingError ? "provider" : "unknown",
          }),
        });
      } catch {
        /* event log best-effort */
      }
      r.resolve(null);
      this.in_flight.delete(r.segment_id);
      return null;
    }
  }

  private cancelRemaining(remaining: Reservation[][]): void {
    for (const batch of remaining) {
      for (const r of batch) {
        r.resolve(null);
        this.in_flight.delete(r.segment_id);
      }
    }
  }
}
