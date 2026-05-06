/**
 * Background segment-embedding pass — Phase 3 of the embeddings
 * retrieval layer.
 *
 * Takes every segment in a project and feeds it through the
 * configured `EmbeddingProvider` in batches, persisting the resulting
 * vector into the `embeddings` table (`scope = "segment"`). Designed
 * to run after intake (for new projects) or as a curator-triggered
 * backfill (for existing projects that just enabled embeddings).
 *
 * Runs as a normal `IntakeRunRow` with `kind = "embedding_pass"` so
 * it shows up on the Intake Runs screen alongside the helper-LLM
 * pre-pass and tone sniff. The bookkeeping mirrors the helper-LLM
 * variants:
 *   - `chunks`            → number of `embed()` batches dispatched
 *   - `cached_chunks`     → batches the cache short-circuited (no
 *                            new vectors written)
 *   - `proposed_count`    → number of segments newly embedded (i.e.
 *                            the "useful work" count, distinct from
 *                            `chunks`)
 *   - `failed_chunks`     → batches that errored without persisting
 *                            anything
 *   - `prompt_tokens`     → cumulative tokens from `EmbeddingResult`
 *   - `cost_usd`          → derived via `estimateCost(model)` for the
 *                            audit ledger; embed pricing lives in
 *                            `src/llm/pricing.ts`.
 *
 * The pass is **best-effort and resumable**: it skips segments that
 * already have an embedding row for the active model, persists each
 * batch independently, and tolerates per-batch failures (logged as
 * `embedding.failed`). A subsequent run picks up where the last one
 * left off — no separate resume cursor needed.
 *
 * Cancellation / abort is plumbed through `signal`; in flight batches
 * complete (so we don't half-write a vector list) but no further
 * batches are scheduled. The run row is then closed with
 * `status = "cancelled"`.
 */

import { openProjectDb } from "@/db/dexie";
import {
  bulkUpsertEmbeddings,
  getEmbedding,
  type UpsertEmbeddingInput,
} from "@/db/repo/embeddings";
import { insertLlmCall } from "@/db/repo/llm_calls";
import { recordIntakeRun } from "@/db/repo/intake";
import { appendEvent } from "@/db/repo/projects";
import { IntakeRunStatus, IntakeRunKind, type SegmentRow } from "@/db/schema";
import {
  PURPOSE_EMBEDDING,
  type EmbeddingProvider,
  EmbeddingError,
} from "@/llm/embeddings/base";
import { estimateCost } from "@/llm/pricing";
import { newId } from "@/lib/id";

export interface EmbeddingPassOptions {
  /** Hard cap on segments embedded in a single run. Useful for tests / progressive backfill. */
  max_segments?: number | null;
  /** Override the provider's batch size for testing. */
  batch_size_override?: number | null;
  /** Optional progress callback fired after each batch. */
  on_progress?: (info: EmbeddingPassProgress) => void;
  /**
   * Number of batches the pass will dispatch concurrently. Defaults
   * to 4. Each batch already covers `provider.batch_size` segments,
   * so 4 concurrent batches typically mean 256 segments in flight per
   * round-trip wave. Bump higher for local providers (Ollama, on-device
   * Xenova) where there's no rate-limit. Set to 1 to keep the v1
   * sequential behaviour.
   */
  parallel_batches?: number;
  /** AbortSignal — cancels remaining batches but lets the current one finish. */
  signal?: AbortSignal;
}

export interface EmbeddingPassProgress {
  embedded: number;
  total_pending: number;
  batches: number;
  cached_batches: number;
  failed_batches: number;
  cost_usd: number;
}

export interface EmbeddingPassSummary {
  intake_run_id: string;
  status: "completed" | "cancelled" | "failed";
  embedded: number;
  cached: number;
  total_segments: number;
  batches: number;
  failed_batches: number;
  prompt_tokens: number;
  cost_usd: number;
  duration_ms: number;
}

/**
 * Embed every segment in `project_id` that doesn't yet have a vector
 * for `provider.model`.
 */
export async function runEmbeddingPass(
  project_id: string,
  provider: EmbeddingProvider,
  options: EmbeddingPassOptions = {},
): Promise<EmbeddingPassSummary> {
  const started_at = Date.now();
  const db = openProjectDb(project_id);

  // Pull the full segment list. We don't filter on `status` because
  // even pending segments benefit from being embedded — the cache
  // fills up while the curator browses the Reader, so the first
  // translate call doesn't pay for the round-trip.
  const all_segments = await db.segments.toArray();
  const total_segments = all_segments.length;

  // Skip segments that already have an embedding for this model.
  // We hit `getEmbedding` per segment rather than over-fetching to
  // keep memory pressure low on large projects.
  const pending: SegmentRow[] = [];
  for (const seg of all_segments) {
    if (!seg.source_text || !seg.source_text.trim()) continue;
    const cached = await getEmbedding(
      "project",
      project_id,
      "segment",
      seg.id,
      provider.model,
    );
    if (cached) continue;
    pending.push(seg);
    if (
      options.max_segments != null &&
      pending.length >= options.max_segments
    ) {
      break;
    }
  }

  await appendEvent(project_id, "embedding.batch_started", {
    model: provider.model,
    pending: pending.length,
    total: total_segments,
  });

  if (pending.length === 0) {
    const finished_at = Date.now();
    const run = await recordIntakeRun({
      project_id,
      kind: IntakeRunKind.EMBEDDING_PASS,
      helper_model: provider.model,
      started_at,
      finished_at,
      status: IntakeRunStatus.COMPLETED,
      chunks: 0,
      cached_chunks: 0,
      proposed_count: 0,
      failed_chunks: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      notes: ["No segments needed embedding."],
    });
    await appendEvent(project_id, "embedding.batch_completed", {
      model: provider.model,
      embedded: 0,
      cached: 0,
      run_id: run.id,
    });
    return {
      intake_run_id: run.id,
      status: "completed",
      embedded: 0,
      cached: 0,
      total_segments,
      batches: 0,
      failed_batches: 0,
      prompt_tokens: 0,
      cost_usd: 0,
      duration_ms: finished_at - started_at,
    };
  }

  // Batch size: prefer caller override → provider hint → conservative
  // default of 16. Larger batches mean fewer round-trips but bigger
  // network payloads; 16 is the sweet spot for OpenAI's cap.
  const batch_size = Math.max(
    1,
    options.batch_size_override ??
      (provider as { batch_size?: number }).batch_size ??
      16,
  );

  let embedded = 0;
  let cached_batches = 0;
  let failed_batches = 0;
  let total_prompt_tokens = 0;
  let total_cost = 0;
  let dispatched = 0;
  let cancelled = false;

  // Pre-slice pending into deterministic batches so concurrent
  // workers don't double-claim a segment. Each batch is a contiguous
  // slice of `pending` so spine order is preserved across the pass.
  const slices: SegmentRow[][] = [];
  for (let i = 0; i < pending.length; i += batch_size) {
    slices.push(pending.slice(i, i + batch_size));
  }

  const parallel = Math.max(1, options.parallel_batches ?? 4);

  let cursor = 0;
  const dispatchOne = async (): Promise<void> => {
    while (true) {
      if (options.signal?.aborted) {
        cancelled = true;
        return;
      }
      const i = cursor++;
      if (i >= slices.length) return;
      const slice = slices[i]!;
      const texts = slice.map((s) => s.source_text);
      dispatched += 1;
      try {
        const result = await provider.embed(texts, options.signal);
        const inserts: UpsertEmbeddingInput[] = [];
        for (let k = 0; k < slice.length; k += 1) {
          const seg = slice[k]!;
          const vec = result.vectors[k];
          if (!vec) continue;
          inserts.push({
            scope: "segment",
            ref_id: seg.id,
            model: provider.model,
            vector: vec,
          });
        }
        if (inserts.length) {
          await bulkUpsertEmbeddings("project", project_id, inserts);
          embedded += inserts.length;
        } else {
          cached_batches += 1;
        }
        const prompt_tokens = result.usage?.prompt_tokens ?? 0;
        total_prompt_tokens += prompt_tokens;
        const cost_usd = estimateCost(provider.model, prompt_tokens, 0);
        total_cost += cost_usd;
        // Audit ledger entry for the batch — keeps embedding spend
        // visible alongside translation calls.
        await insertLlmCall(project_id, {
          id: newId(),
          project_id,
          segment_id: null,
          model: provider.model,
          purpose: PURPOSE_EMBEDDING,
          request_json: JSON.stringify({
            provider: provider.name,
            model: provider.model,
            scope: "segment",
            kind: "embedding_pass",
            batch_idx: i,
            input_count: slice.length,
            segment_ids: slice.map((s) => s.id),
          }),
          response_json: JSON.stringify({
            vectors: inserts.length,
            dim: result.vectors[0]?.length ?? null,
            model: result.model,
            usage: result.usage,
            duration_ms: result.duration_ms ?? null,
            raw: result.raw,
          }),
          prompt_tokens,
          completion_tokens: 0,
          cost_usd,
          cache_hit: false,
          cache_key: null,
          duration_ms: result.duration_ms ?? null,
        });
      } catch (err) {
        failed_batches += 1;
        const message = err instanceof Error ? err.message : String(err);
        await appendEvent(project_id, "embedding.failed", {
          model: provider.model,
          batch_idx: i,
          error: message,
          cause: err instanceof EmbeddingError ? "provider" : "unknown",
        });
      }

      options.on_progress?.({
        embedded,
        total_pending: pending.length,
        batches: dispatched,
        cached_batches,
        failed_batches,
        cost_usd: total_cost,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(parallel, slices.length) }, () =>
      dispatchOne(),
    ),
  );

  const finished_at = Date.now();
  const status_t =
    cancelled
      ? IntakeRunStatus.CANCELLED
      : failed_batches > 0 && embedded === 0
      ? IntakeRunStatus.FAILED
      : IntakeRunStatus.COMPLETED;
  const run = await recordIntakeRun({
    project_id,
    kind: IntakeRunKind.EMBEDDING_PASS,
    helper_model: provider.model,
    started_at,
    finished_at,
    status: status_t,
    chunks: dispatched,
    cached_chunks: cached_batches,
    proposed_count: embedded,
    failed_chunks: failed_batches,
    prompt_tokens: total_prompt_tokens,
    completion_tokens: 0,
    cost_usd: total_cost,
    notes: [
      `Embedded ${embedded}/${pending.length} segment${pending.length === 1 ? "" : "s"} in ${dispatched} batch${dispatched === 1 ? "" : "es"}.`,
    ],
  });
  await appendEvent(project_id, "embedding.batch_completed", {
    model: provider.model,
    embedded,
    cached: cached_batches,
    failed: failed_batches,
    run_id: run.id,
    status: status_t,
  });

  return {
    intake_run_id: run.id,
    status:
      status_t === IntakeRunStatus.CANCELLED
        ? "cancelled"
        : status_t === IntakeRunStatus.FAILED
        ? "failed"
        : "completed",
    embedded,
    cached: cached_batches,
    total_segments,
    batches: dispatched,
    failed_batches,
    prompt_tokens: total_prompt_tokens,
    cost_usd: total_cost,
    duration_ms: finished_at - started_at,
  };
}
