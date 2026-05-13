/**
 * Batch translation runner (mirrors `epublate.core.batch`).
 *
 * Walks a project's pending segments, calls `translateSegment` on each
 * (with bounded concurrency), and aggregates per-segment outcomes into
 * a `BatchSummary` the curator (or the Inbox screen) can act on.
 *
 * Hard rules from the PRD:
 *
 * - **Concurrency cap.** Defaults to 1; user-configurable. We use a
 *   simple "N in-flight at once" Promise pool — fetch is already
 *   off-main-thread, so a Web Worker pool would just add IPC overhead
 *   for no win in v1.
 * - **Budget cap.** When cumulative spend would cross
 *   `options.budget_usd`, we stop submitting new tasks, drain the
 *   in-flight ones, append a `batch.paused` event, and throw
 *   `BatchPaused`. The caller resumes after raising the cap.
 * - **Failure isolation.** Per-segment failures are caught at the
 *   worker boundary, recorded as `batch.segment_failed` events, and
 *   *do not abort* the batch.
 * - **Cancellation.** The `AbortSignal` is checked between submissions
 *   and propagated to the per-segment LLM call. Already-in-flight
 *   requests are best-effort cancelled via the same signal so their
 *   `fetch` is aborted promptly.
 *
 * Cache hits cost zero, so they don't count against the budget; this
 * matches the Reader's accounting model and lets a curator re-run a
 * batch on a populated cache without paying a second time.
 */

import {
  translateSegment,
  type LoreRetrievalOptions,
  type TranslateOutcome,
} from "@/core/pipeline";
import { EmbeddingPrefetcher } from "@/core/embedding_prefetch";
import { runPrePass, type IntakeOptions } from "@/core/extractor";
import { listGlossaryEntries } from "@/db/repo/glossary";
import { rowToSegment } from "@/db/repo/segments";
import { openProjectDb } from "@/db/dexie";
import { libraryDb, readLlmConfig } from "@/db/library";
import {
  buildEmbeddingProvider,
  type ProjectEmbeddingOverrides,
} from "@/llm/embeddings/factory";
import { type EmbeddingProvider } from "@/llm/embeddings/base";
import { resolveProjectGlossaryWithLore } from "@/lore/attach";
import { nowMs } from "@/lib/time";
import { type LLMProvider, type RateLimitHint } from "@/llm/base";
import { LLMRateLimitError } from "@/llm/base";
import { Throttle } from "@/lib/throttle";
import {
  SegmentStatus,
  type SegmentRow,
  type SegmentStatusT,
  type BatchRetryConfig,
} from "@/db/schema";

/**
 * Documented defaults for the batch-level retry / circuit-breaker.
 * Distinct from the per-request provider retry (`DEFAULT_RETRY_POLICY`
 * in `src/llm/openai_compat.ts`): these run *after* the provider has
 * already exhausted its own retries and bubbled a failure for the
 * segment. Values picked to be conservative on cloud (where transient
 * errors are rare) yet forgiving on local Ollama (where a slow first
 * generation routinely times out before the model is hot).
 *
 * Tuning suggestions:
 *
 * - Bump `max_retries_per_segment` (1 → 3) for flaky hosted endpoints.
 * - Tighten `max_errors_in_window` for fast-fail behaviour during
 *   capture / screenshot runs.
 * - Loosen `error_window_size` (100 → 500) for very long books where
 *   a brief outage shouldn't trip the breaker after only 10 segments.
 */
export const BATCH_RETRY_DEFAULTS: Required<BatchRetryConfig> = {
  max_retries_per_segment: 2,
  error_window_size: 100,
  max_errors_in_window: 10,
};

/**
 * Derive an effective in-flight concurrency cap from the configured
 * cap and the most recent rate-limit hint from the provider.
 *
 * Policy (deliberately simple — provider hints are noisy):
 *
 * - No hint, or `remaining_requests` is `null` → keep the configured
 *   cap unchanged. This is the path every non-OpenAI provider takes,
 *   so the helper is a no-op for `mock`, raw Ollama, llama.cpp, etc.
 * - Otherwise the effective cap is `floor(remaining / 2)`, clamped
 *   to `[1, configured]`. We never amplify beyond the curator's
 *   chosen value and we always make forward progress (floor = 1).
 *
 * The `÷2` is the "leave half the window for someone else"
 * safety factor — gives the throttle some slack so a brief co-tenant
 * spike doesn't push the next call into a 429.
 *
 * Exported (and `internal`) so the batch tests can pin the policy.
 */
export function deriveConcurrencyCap(
  configured: number,
  hint: RateLimitHint | null,
): number {
  if (!hint) return configured;
  const rem = hint.remaining_requests;
  if (rem === null || !Number.isFinite(rem)) return configured;
  const budget = Math.max(1, Math.floor(rem / 2));
  return Math.min(configured, budget);
}

/**
 * Clamp a hand-edited (or undefined) `BatchRetryConfig` into a fully
 * populated, sane shape. Any missing or out-of-range field falls back
 * to `BATCH_RETRY_DEFAULTS`. Negative / non-finite numbers are
 * treated as "use default", not "disable". Window size is forced to
 * be at least the failure threshold so the breaker stays meaningful.
 */
export function resolveBatchRetryConfig(
  raw: BatchRetryConfig | null | undefined,
): Required<BatchRetryConfig> {
  const r = raw ?? {};
  const max_retries =
    typeof r.max_retries_per_segment === "number" &&
    Number.isFinite(r.max_retries_per_segment) &&
    r.max_retries_per_segment >= 0
      ? Math.trunc(r.max_retries_per_segment)
      : BATCH_RETRY_DEFAULTS.max_retries_per_segment;
  const window =
    typeof r.error_window_size === "number" &&
    Number.isFinite(r.error_window_size) &&
    r.error_window_size > 0
      ? Math.trunc(r.error_window_size)
      : BATCH_RETRY_DEFAULTS.error_window_size;
  const threshold =
    typeof r.max_errors_in_window === "number" &&
    Number.isFinite(r.max_errors_in_window) &&
    r.max_errors_in_window > 0
      ? Math.trunc(r.max_errors_in_window)
      : BATCH_RETRY_DEFAULTS.max_errors_in_window;
  return {
    max_retries_per_segment: max_retries,
    error_window_size: Math.max(window, threshold),
    max_errors_in_window: threshold,
  };
}

export interface BatchOptions {
  model: string;
  /** Number of in-flight LLM calls. Defaults to 1. */
  concurrency?: number;
  /** Max cumulative cost (USD) before the batch pauses. */
  budget_usd?: number | null;
  /** Restrict the run to specific chapters. */
  chapter_ids?: readonly string[] | null;
  /** Bypass cache (re-translate from scratch). */
  bypass_cache?: boolean;
  /** Style guide override; falls back to project row. */
  style_guide?: string | null;
  /**
   * Reasoning-effort knob. OpenAI o-series accepts
   * `minimal | low | medium | high`; Ollama-compat extends with
   * `none` to disable thinking on thinking-capable models.
   */
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | "none" | null;
  /**
   * Helper-LLM pre-pass: when set, runs `runPrePass` once per chapter
   * just before its segments hit the translator, so the glossary picks
   * up new proposed entries early in the batch. Disabled by default.
   */
  pre_pass?: IntakeOptions | null;
  /**
   * Number of embedding `embed()` calls running in parallel with the
   * translator pool. Each call already pulls `provider.batch_size`
   * segments, so 4 concurrent calls embed `4 * batch_size` segments
   * per network wave (≈ 256 for OpenAI's default of 64). Defaults to
   * `4`. Set higher for local Ollama where there's no rate limit.
   */
  embedding_parallel_batches?: number;
  /**
   * Batch-level retry / circuit-breaker config. `null` /
   * `undefined` ⇒ use `BATCH_RETRY_DEFAULTS`. Values are clamped on
   * read by `resolveBatchRetryConfig`, so a hand-edited Dexie row
   * can't disable the breaker by accident.
   */
  retry?: BatchRetryConfig | null;
}

export interface BatchSummary {
  translated: number;
  cached: number;
  flagged: number;
  failed: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  elapsed_s: number;
  /** Total work units; populated upfront so the meter has a denominator. */
  total: number;
  /** Set when the run paused (budget cap or rate-limit hit). */
  paused_reason: string | null;
  /** `(segment_id, error_message)` tuples for the Inbox. */
  failures: Array<{ segment_id: string; error: string }>;
}

export function createSummary(): BatchSummary {
  return {
    translated: 0,
    cached: 0,
    flagged: 0,
    failed: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    elapsed_s: 0,
    total: 0,
    paused_reason: null,
    failures: [],
  };
}

export interface BatchProgressEvent {
  segment_id: string;
  chapter_id: string;
  outcome: TranslateOutcome | null;
  error: string | null;
  summary: BatchSummary;
}

export type ProgressCallback = (ev: BatchProgressEvent) => void;

/**
 * Fired immediately before a segment's translateSegment call begins,
 * and again after it settles (success or failure). The UI uses this
 * to render in-flight indicators in the Reader and chapter list while
 * a batch is running — distinct from `on_progress`, which only fires
 * after the call completes.
 */
export type SegmentLifecycleCallback = (ev: {
  segment_id: string;
  chapter_id: string;
}) => void;

/**
 * Thrown when the batch stops on its budget cap or because the
 * provider is rate-limited. The partial summary is attached so the
 * caller can surface it.
 */
export class BatchPaused extends Error {
  summary: BatchSummary;
  constructor(message: string, summary: BatchSummary) {
    super(message);
    this.name = "BatchPaused";
    this.summary = summary;
  }
}

/** Curator-initiated cancel; partial summary still attached. */
export class BatchCancelled extends Error {
  summary: BatchSummary;
  constructor(message: string, summary: BatchSummary) {
    super(message);
    this.name = "BatchCancelled";
    this.summary = summary;
  }
}

export interface RunBatchInput {
  project_id: string;
  source_lang: string;
  target_lang: string;
  provider: LLMProvider;
  options: BatchOptions;
  /** Pre-filtered work list. When unset we read all PENDING segments. */
  segments?: SegmentRow[];
  /** Resolved live with `useLiveQuery` in the UI. */
  glossary_state?: ReadonlyArray<unknown> | null;
  on_progress?: ProgressCallback;
  /** Fired before each segment's translateSegment call starts. */
  on_segment_start?: SegmentLifecycleCallback;
  /** Fired after each segment settles, regardless of outcome. */
  on_segment_end?: SegmentLifecycleCallback;
  signal?: AbortSignal;
  /**
   * When set, the runner continues a previous batch instead of
   * starting from zero. Counters in the new summary are pre-loaded
   * from the baseline, and `summary.total` is grown to fit so the
   * BatchStatusBar's meter never moves backwards across the resume
   * boundary.
   *
   * Used by the auto-resume hook (`useResumeInterruptedBatch`) after
   * a page refresh. The baseline carries no AbortController and no
   * provider state — it's just an accumulator snapshot.
   */
  resume_baseline?: BatchSummary | null;
}

/**
 * Run a batch and return its final summary on success, or throw
 * `BatchPaused` / `BatchCancelled` carrying the partial summary.
 */
export async function runBatch(input: RunBatchInput): Promise<BatchSummary> {
  const {
    project_id,
    source_lang,
    target_lang,
    provider,
    options,
    on_progress,
    on_segment_start,
    on_segment_end,
    signal,
  } = input;

  const concurrency = Math.max(1, options.concurrency ?? 1);
  // Resolve the retry / circuit-breaker config once. Clamps every
  // field against the sane defaults so a hand-edited Dexie row
  // can't break the breaker.
  const retry_cfg = resolveBatchRetryConfig(options.retry ?? null);
  // Sliding-window outcome log: `true` ⇒ failure (after all per-
  // segment retries exhausted), `false` ⇒ success. Workers push at
  // the end and trim from the head so the array length stays
  // bounded by `error_window_size`.
  const outcome_window: boolean[] = [];

  const detail_db = openProjectDb(project_id);
  const detail = await detail_db.projects.get(project_id);
  if (!detail) throw new Error(`project not found: ${project_id}`);

  const effective_budget =
    options.budget_usd === undefined
      ? detail.budget_usd
      : options.budget_usd;
  const effective_style_guide =
    options.style_guide === undefined ? detail.style_guide : options.style_guide;
  // Snapshot the project's book summary + prompt-block toggles once
  // for the whole run. The pipeline could re-read them per segment,
  // but the curator's expectation is "this batch uses the project
  // settings as they were when I clicked Run" — same model as the
  // glossary snapshot below.
  const effective_book_summary = detail.book_summary ?? null;
  const effective_prompt_options = detail.prompt_options ?? null;

  // Per-chapter note cache. We resolve once on demand (and only for
  // chapters that actually have pending segments) and reuse across
  // every segment in the chapter — `notes` rarely changes mid-batch
  // and rebuilding the prompt with stale notes is fine, the cache key
  // already incorporates them.
  const chapter_notes_cache = new Map<string, string | null>();
  async function chapterNotesFor(chapter_id: string): Promise<string | null> {
    if (chapter_notes_cache.has(chapter_id)) {
      return chapter_notes_cache.get(chapter_id) ?? null;
    }
    const row = await detail_db.chapters.get(chapter_id);
    const cleaned = row?.notes?.trim() ?? null;
    const value = cleaned ? cleaned : null;
    chapter_notes_cache.set(chapter_id, value);
    return value;
  }

  // Resolve the work list once; status changes that happen mid-run
  // don't reorder it (we still skip already-translated segments via a
  // status check just before each submission).
  const pending =
    input.segments ?? (await selectPending(project_id, options.chapter_ids ?? null));

  // Phase 2: try to build an embedding provider. When one is
  // available we keep the project-side glossary unmerged and let the
  // pipeline retrieve top-K Lore-Book entries per segment. When the
  // provider is "none" / unavailable we keep the legacy v1 behaviour
  // of flattening every attached Lore Book into the prompt.
  let lore_retrieval: LoreRetrievalOptions | null = null;
  let embedding_provider_for_pipeline: EmbeddingProvider | null = null;
  try {
    const library = await readLlmConfig();
    let project_emb_overrides: ProjectEmbeddingOverrides | null = null;
    if (detail.llm_overrides) {
      try {
        const parsed = JSON.parse(detail.llm_overrides) as {
          embedding?: ProjectEmbeddingOverrides | null;
        };
        project_emb_overrides = parsed.embedding ?? null;
      } catch {
        project_emb_overrides = null;
      }
    }
    const built = await buildEmbeddingProvider({
      configOverride: library,
      overrides: project_emb_overrides,
    });
    if (built.provider) {
      lore_retrieval = { provider: built.provider };
      embedding_provider_for_pipeline = built.provider;
    }
  } catch {
    // Embedding builder failures fall back to the legacy merge.
    lore_retrieval = null;
    embedding_provider_for_pipeline = null;
  }

  // Glossary state: capture once at start. Reading it on each segment
  // would be defensible too, but the curator's expectation is "this
  // batch uses the glossary as it was when I clicked Run" — and a
  // mid-batch edit triggers the cascade flow, which resets affected
  // segments to pending anyway.
  let project_glossary_state: Awaited<ReturnType<typeof listGlossaryEntries>> =
    (input.glossary_state as Awaited<ReturnType<typeof listGlossaryEntries>>) ??
    (await listGlossaryEntries(project_id));
  // When no embedding provider is available we still flatten
  // attached Lore Books into the prompt up front (legacy v1).
  // Otherwise the pipeline merges per-segment via cosineTopK.
  let glossary_state: Awaited<ReturnType<typeof listGlossaryEntries>> =
    lore_retrieval
      ? project_glossary_state
      : await resolveProjectGlossaryWithLore(project_id, project_glossary_state);

  // Resume continuity: when the caller supplies a baseline summary
  // (auto-resume after refresh), preserve its accumulators and grow
  // `total` so the BatchStatusBar meter doesn't reset to "0/N" or
  // jump backwards. The new run's pending list is a *subset* of the
  // original work — we just keep counting onto the existing tally.
  const baseline = input.resume_baseline ?? null;
  const summary = baseline ? cloneSummary(baseline) : createSummary();
  // Re-derive total from baseline_done + remaining_pending so the
  // meter stays accurate even if the curator manually translated a
  // few segments between the original start and the refresh, or if
  // a glossary cascade reset previously-translated segments back to
  // pending.
  const baseline_done = baseline
    ? baseline.translated + baseline.cached + baseline.flagged + baseline.failed
    : 0;
  summary.total = baseline ? baseline_done + pending.length : pending.length;
  // `paused_reason` from the baseline is stale — we're starting again.
  summary.paused_reason = null;
  const started = performance.now();
  // Carry the baseline's elapsed_s forward so the BatchStatusBar
  // ETA heuristic (rate = done / elapsed_s) divides cumulative work
  // by cumulative time and stays sane across the resume boundary.
  // Workers update `elapsed_s` as `baseline_elapsed + this-run-elapsed`.
  const baseline_elapsed_s = baseline?.elapsed_s ?? 0;

  await appendEvent(project_id, "batch.started", {
    model: options.model,
    concurrency,
    budget_usd: effective_budget,
    segment_count: pending.length,
    chapter_ids: options.chapter_ids ?? null,
    resumed: baseline !== null,
    resumed_baseline_done: baseline_done,
  });

  if (pending.length === 0) {
    summary.elapsed_s =
      baseline_elapsed_s + (performance.now() - started) / 1000;
    await appendEvent(project_id, "batch.completed", summaryPayload(summary));
    return summary;
  }

  let paused = false;
  let pause_reason: string | null = null;
  let cancelled = false;

  // Per-chapter helper-LLM pre-pass. Running it sequentially up front
  // (rather than racing with the translator pool) means the glossary
  // is fully populated before any translation prompt is built — which
  // is the entire point of the helper. Failed chunks don't sink the
  // batch; they're already audited by the extractor itself.
  if (options.pre_pass) {
    const pre_opts = options.pre_pass;
    const seen = new Set<string>();
    const ordered_chapters: string[] = [];
    for (const seg of pending) {
      if (seen.has(seg.chapter_id)) continue;
      seen.add(seg.chapter_id);
      ordered_chapters.push(seg.chapter_id);
    }
    for (const chapter_id of ordered_chapters) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
      const ch_segs = pending.filter((s) => s.chapter_id === chapter_id);
      try {
        await runPrePass({
          project_id,
          source_lang,
          target_lang,
          provider,
          options: pre_opts,
          segments: ch_segs,
          signal,
        });
      } catch (err: unknown) {
        if (err instanceof LLMRateLimitError) {
          paused = true;
          pause_reason = formatRateLimitPause(err);
          break;
        }
        // The extractor already audits its own failures; the batch
        // continues without it on any other error class.
      }
    }
    if (!paused && !cancelled) {
      // Pre-pass may have promoted new entries; refresh the snapshot.
      // Whether we re-merge with Lore Books here depends on whether
      // we're letting the pipeline do per-segment retrieval.
      project_glossary_state = await listGlossaryEntries(project_id);
      glossary_state = lore_retrieval
        ? project_glossary_state
        : await resolveProjectGlossaryWithLore(
            project_id,
            project_glossary_state,
          );
    }
  }

  // Embedding prefetcher: when a provider is available, kick off a
  // bulk warm-cache pass *in parallel* with the translator workers.
  // The prefetcher reserves an in-flight promise per segment before
  // it dispatches each batch, so workers that race ahead pick up the
  // shared promise instead of firing redundant singleton embeds.
  // When no provider is configured we skip the prefetcher entirely;
  // the pipeline still works (`embedding_provider` stays null) and
  // simply doesn't do retrieval.
  const prefetcher = embedding_provider_for_pipeline
    ? new EmbeddingPrefetcher(
        project_id,
        embedding_provider_for_pipeline,
        signal,
      )
    : null;
  const prefetch_promise = prefetcher
    ? prefetcher
        .warmCache(pending, {
          parallel_batches: Math.max(
            1,
            options.embedding_parallel_batches ?? 4,
          ),
        })
        .catch(() => {
          // Warm-cache failures fall back to per-segment singleton
          // embeds; the prefetcher already audits the failure event.
        })
    : Promise.resolve();

  // Sliding-window pool: fire `concurrency` workers; each pulls the
  // next segment off the cursor until the queue is empty, the budget
  // trips, or the curator cancels. Workers also handle their own
  // failure-isolation so one segment's exception doesn't sink the
  // others.
  let cursor = 0;
  // Adaptive concurrency: a shared throttle whose cap may shrink
  // below the configured `concurrency` when the provider's
  // `x-ratelimit-remaining-requests` is low, and recover back up to
  // it as the window resets. Workers `acquire()` immediately before
  // calling `translateSegment` and `release()` in the matching
  // `finally`. When the provider doesn't expose rate-limit headers
  // (mock, raw Ollama, llama.cpp) the cap stays at `concurrency` for
  // the entire run and the throttle is a no-op gate — identical
  // wall-clock to the pre-throttle code path.
  const throttle = new Throttle(concurrency);
  // Snapshot of the effective cap at last adjustment, so we can fire
  // an audit event only on transitions instead of every successful
  // segment.
  let last_effective_cap = concurrency;

  function adjustCapFromProvider(): void {
    if (typeof provider.getRateLimitHint !== "function") return;
    const hint = provider.getRateLimitHint();
    const effective = deriveConcurrencyCap(concurrency, hint);
    if (effective !== throttle.currentCap) {
      throttle.setCap(effective);
      if (effective !== last_effective_cap) {
        // Don't await: audit is best-effort and the worker has
        // useful work to do.
        void appendEvent(project_id, "batch.concurrency_adjusted", {
          from: last_effective_cap,
          to: effective,
          configured: concurrency,
          remaining_requests: hint?.remaining_requests ?? null,
          remaining_tokens: hint?.remaining_tokens ?? null,
          reset_requests_ms: hint?.reset_requests_ms ?? null,
        });
        last_effective_cap = effective;
      }
    }
  }

  async function worker(): Promise<void> {
    while (true) {
      if (cancelled || paused) return;
      if (signal?.aborted) {
        cancelled = true;
        return;
      }
      // Park here until the adaptive throttle has a free slot, so
      // we never exceed the dynamic cap even when more workers were
      // spawned than the cap currently allows. The throttle is
      // re-checked after acquire so a shrunken cap can re-park us.
      await throttle.acquire();
      if (cancelled || paused) {
        throttle.release();
        return;
      }
      if (signal?.aborted) {
        cancelled = true;
        throttle.release();
        return;
      }
      const i = cursor++;
      if (i >= pending.length) {
        throttle.release();
        return;
      }
      const seg_row = pending[i]!;
      const seg = rowToSegment(seg_row);
      // The "in-flight" pulse is fired around every translateSegment
      // call — including the no-op cache-hit and trivially-empty
      // paths — so the Reader's segment cards keep their pending
      // highlights consistent with what the worker is actually doing.
      try {
        on_segment_start?.({
          segment_id: seg.id,
          chapter_id: seg.chapter_id,
        });
      } catch {
        // Lifecycle callbacks must never sink the batch.
      }
      try {
        // Per-segment retry loop. Distinct from the provider's own
        // retry policy: this layer fires only after the provider
        // has already exhausted its retries and bubbled a failure
        // for the whole segment (typically a timeout or persistent
        // CORS / 5xx class). We retry the *entire* `translateSegment`
        // call so the prompt rebuild, glossary merge, and audit-row
        // write all happen fresh on each attempt — the same way a
        // curator-initiated re-run would.
        const max_retries = retry_cfg.max_retries_per_segment;
        let final_error: string | null = null;
        let succeeded = false;
        let rate_limit_pause: LLMRateLimitError | null = null;
        let was_cancelled = false;
        for (let attempt = 0; attempt <= max_retries; attempt += 1) {
          if (cancelled || paused) break;
          if (signal?.aborted) {
            was_cancelled = true;
            break;
          }
          try {
            const chapter_notes = await chapterNotesFor(seg.chapter_id);
            const outcome = await translateSegment({
              project_id,
              source_lang,
              target_lang,
              style_guide: effective_style_guide,
              book_summary: effective_book_summary,
              prompt_options: effective_prompt_options,
              chapter_notes,
              segment: seg,
              provider,
              options: {
                model: options.model,
                bypass_cache: options.bypass_cache,
                reasoning_effort: options.reasoning_effort ?? null,
                glossary_state: glossary_state,
                lore_retrieval,
                // Phase 3: pass the same provider so `relevant`
                // context mode works when the curator hasn't
                // attached a Lore Book. The pipeline only embeds
                // when a request actually needs the vector (lore-
                // retrieval and/or relevant context), so this stays
                // a no-op for `previous` / `dialogue` modes.
                embedding_provider: embedding_provider_for_pipeline,
                // Workers ask the prefetcher first; if the segment's
                // batch is in flight they join its promise,
                // otherwise they hit the IDB cache or fall back to
                // a singleton embed (also registered so peer
                // workers piggyback).
                embedding_prefetcher: prefetcher,
                signal,
              },
            });
            applyOutcome(summary, outcome);
            const over_budget =
              effective_budget !== null &&
              effective_budget !== undefined &&
              summary.cost_usd > effective_budget;
            summary.elapsed_s =
              baseline_elapsed_s + (performance.now() - started) / 1000;
            on_progress?.({
              segment_id: seg.id,
              chapter_id: seg.chapter_id,
              outcome,
              error: null,
              summary: cloneSummary(summary),
            });
            if (over_budget && !paused) {
              paused = true;
              pause_reason = `budget cap $${effective_budget!.toFixed(4)} reached at $${summary.cost_usd.toFixed(4)}`;
            }
            succeeded = true;
            break;
          } catch (exc: unknown) {
            if (exc instanceof LLMRateLimitError) {
              // Rate limits abort the *batch*, not the segment —
              // the segment stays pending so the next run picks it
              // up.
              rate_limit_pause = exc;
              break;
            }
            if (signal?.aborted) {
              was_cancelled = true;
              break;
            }
            const msg = exc instanceof Error ? exc.message : String(exc);
            final_error = msg;
            // Audit each retry separately so the activity log shows
            // the actual pattern (timeout → timeout → success vs
            // timeout → 500 → 500 — the latter is a real outage).
            await appendEvent(project_id, "batch.segment_retry", {
              segment_id: seg_row.id,
              chapter_id: seg_row.chapter_id,
              attempt,
              max_retries,
              error: msg,
              will_retry: attempt < max_retries,
            });
            if (attempt >= max_retries) break;
            // No exponential backoff at this layer — the provider
            // already backs off internally and a long second-level
            // sleep would just bloat the wall-clock with no real
            // chance of changing the outcome. The breaker handles
            // "too many failures in a row" instead.
          }
        }
        if (rate_limit_pause) {
          if (!paused) {
            paused = true;
            pause_reason = formatRateLimitPause(rate_limit_pause);
          }
          // Don't count rate-limited segments against the breaker —
          // they're a controlled pause, not a failure pattern.
          return;
        }
        if (was_cancelled) {
          cancelled = true;
          return;
        }
        if (succeeded) {
          // Sliding-window record on success too — a successful
          // segment that follows a string of failures should clear
          // the breaker counter as the window slides forward.
          recordOutcome(false);
        } else {
          // All retries exhausted — record the segment failure
          // exactly once and check the circuit breaker before
          // letting the next segment start.
          const msg =
            final_error ?? "translation failed (no error captured)";
          summary.failed += 1;
          summary.failures.push({ segment_id: seg_row.id, error: msg });
          await appendEvent(project_id, "batch.segment_failed", {
            segment_id: seg_row.id,
            chapter_id: seg_row.chapter_id,
            error: msg,
            attempts_used: max_retries + 1,
          });
          summary.elapsed_s =
            baseline_elapsed_s + (performance.now() - started) / 1000;
          on_progress?.({
            segment_id: seg_row.id,
            chapter_id: seg_row.chapter_id,
            outcome: null,
            error: msg,
            summary: cloneSummary(summary),
          });
          recordOutcome(true);
          if (!paused && shouldTripCircuitBreaker()) {
            paused = true;
            const fail_count = outcome_window.filter(Boolean).length;
            pause_reason =
              `circuit breaker tripped: ${fail_count} of the last ` +
              `${outcome_window.length} segments failed (threshold ` +
              `${retry_cfg.max_errors_in_window} of ` +
              `${retry_cfg.error_window_size}). Fix the underlying ` +
              `error and resume the batch.`;
            await appendEvent(project_id, "batch.circuit_breaker", {
              window_size: outcome_window.length,
              failures_in_window: fail_count,
              threshold: retry_cfg.max_errors_in_window,
              window_capacity: retry_cfg.error_window_size,
            });
          }
        }
      } finally {
        try {
          on_segment_end?.({
            segment_id: seg.id,
            chapter_id: seg.chapter_id,
          });
        } catch {
          // Lifecycle callbacks must never sink the batch.
        }
        // Sample the provider's most recent x-ratelimit-* snapshot
        // and adjust the throttle BEFORE releasing the slot, so the
        // next worker to acquire sees the up-to-date cap. Safe under
        // failure: a failed call typically still observed response
        // headers on a non-rate-limited HTTP path, and a rate-limit
        // pause has already set `paused = true` above.
        adjustCapFromProvider();
        throttle.release();
      }
    }
    // Make sure no peer worker is parked on us when we exit. A peer
    // that wakes after pause/cancel sees the flags and exits cleanly.
    if (cancelled || paused) throttle.drainWaiters();
  }

  function recordOutcome(failed: boolean): void {
    outcome_window.push(failed);
    while (outcome_window.length > retry_cfg.error_window_size) {
      outcome_window.shift();
    }
  }

  function shouldTripCircuitBreaker(): boolean {
    if (outcome_window.length < retry_cfg.max_errors_in_window) return false;
    let fails = 0;
    for (const x of outcome_window) {
      if (x) fails += 1;
    }
    return fails >= retry_cfg.max_errors_in_window;
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, () =>
      worker(),
    ),
  );

  // Make sure any straggler embedding batches finish (and write
  // their audit rows) before we mark the run complete. The workers
  // may have finished translation while a final embedding batch is
  // still in flight; awaiting it here keeps the audit log clean and
  // the IDB cache populated for the next run.
  try {
    await prefetch_promise;
  } catch {
    /* prefetcher already audited its own failures */
  }

  summary.elapsed_s =
    baseline_elapsed_s + (performance.now() - started) / 1000;

  if (paused) {
    summary.paused_reason = pause_reason;
    await appendEvent(project_id, "batch.paused", {
      ...summaryPayload(summary),
      reason: pause_reason,
      budget_usd: effective_budget,
    });
    throw new BatchPaused(pause_reason ?? "batch paused", summary);
  }
  if (cancelled) {
    await appendEvent(project_id, "batch.cancelled", {
      ...summaryPayload(summary),
      reason: "cancelled by user",
    });
    throw new BatchCancelled("batch cancelled by user", summary);
  }

  await appendEvent(project_id, "batch.completed", summaryPayload(summary));
  return summary;
}

function applyOutcome(summary: BatchSummary, outcome: TranslateOutcome): void {
  summary.prompt_tokens += outcome.prompt_tokens;
  summary.completion_tokens += outcome.completion_tokens;
  summary.cost_usd += outcome.cost_usd;
  if (outcome.violations.length) {
    summary.flagged += 1;
  } else if (outcome.cache_hit) {
    summary.cached += 1;
  } else {
    summary.translated += 1;
  }
}

function cloneSummary(s: BatchSummary): BatchSummary {
  return {
    ...s,
    failures: s.failures.map((f) => ({ ...f })),
  };
}

function summaryPayload(summary: BatchSummary): Record<string, unknown> {
  return {
    translated: summary.translated,
    cached: summary.cached,
    flagged: summary.flagged,
    failed: summary.failed,
    prompt_tokens: summary.prompt_tokens,
    completion_tokens: summary.completion_tokens,
    cost_usd: summary.cost_usd,
    elapsed_s: summary.elapsed_s,
  };
}

async function appendEvent(
  project_id: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const db = openProjectDb(project_id);
  await db.events.add({
    project_id,
    ts: nowMs(),
    kind,
    payload_json: JSON.stringify(payload),
  });
  // Library row's `opened_at` already nudged by other paths; not
  // reusing it here so a long-running batch doesn't keep the project
  // in the recents top spot beyond its actual last user touch.
  void libraryDb;
}

function formatRateLimitPause(err: LLMRateLimitError): string {
  const base = err.reason || err.message;
  if (err.retry_after_seconds === null || err.retry_after_seconds <= 0) {
    return `rate limit hit: ${base} (switch model, add credits, or wait and resume)`;
  }
  const secs = err.retry_after_seconds;
  let wait: string;
  if (secs < 60) wait = `${Math.round(secs)}s`;
  else if (secs < 3600) wait = `~${Math.round(secs / 60)} min`;
  else wait = `~${(secs / 3600).toFixed(1)} h`;
  return `rate limit hit: ${base} (resets in ${wait}; switch model, add credits, or wait and resume)`;
}

async function selectPending(
  project_id: string,
  chapter_ids: readonly string[] | null,
): Promise<SegmentRow[]> {
  const db = openProjectDb(project_id);
  let rows = await db.segments
    .where("status")
    .equals(SegmentStatus.PENDING as SegmentStatusT)
    .toArray();
  if (chapter_ids && chapter_ids.length) {
    const set = new Set(chapter_ids);
    rows = rows.filter((r) => set.has(r.chapter_id));
  }
  // Stable spine-major / segment-minor order so progress events land
  // in reading order and the meter feels predictable.
  const chapters = await db.chapters.toArray();
  const spineIdx = new Map(chapters.map((c) => [c.id, c.spine_idx]));
  rows.sort((a, b) => {
    const sa = spineIdx.get(a.chapter_id) ?? 0;
    const sb = spineIdx.get(b.chapter_id) ?? 0;
    if (sa !== sb) return sa - sb;
    return a.idx - b.idx;
  });
  return rows;
}
