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

import { translateSegment, type TranslateOutcome } from "@/core/pipeline";
import { runPrePass, type IntakeOptions } from "@/core/extractor";
import { listGlossaryEntries } from "@/db/repo/glossary";
import { rowToSegment } from "@/db/repo/segments";
import { openProjectDb } from "@/db/dexie";
import { libraryDb } from "@/db/library";
import { resolveProjectGlossaryWithLore } from "@/lore/attach";
import { nowMs } from "@/lib/time";
import { type LLMProvider } from "@/llm/base";
import { LLMRateLimitError } from "@/llm/base";
import {
  SegmentStatus,
  type SegmentRow,
  type SegmentStatusT,
} from "@/db/schema";

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
  /** OpenAI o-series reasoning-effort knob. */
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | null;
  /**
   * Helper-LLM pre-pass: when set, runs `runPrePass` once per chapter
   * just before its segments hit the translator, so the glossary picks
   * up new proposed entries early in the batch. Disabled by default.
   */
  pre_pass?: IntakeOptions | null;
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

  const detail_db = openProjectDb(project_id);
  const detail = await detail_db.projects.get(project_id);
  if (!detail) throw new Error(`project not found: ${project_id}`);

  const effective_budget =
    options.budget_usd === undefined
      ? detail.budget_usd
      : options.budget_usd;
  const effective_style_guide =
    options.style_guide === undefined ? detail.style_guide : options.style_guide;

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

  // Glossary state: capture once at start. Reading it on each segment
  // would be defensible too, but the curator's expectation is "this
  // batch uses the glossary as it was when I clicked Run" — and a
  // mid-batch edit triggers the cascade flow, which resets affected
  // segments to pending anyway.
  let glossary_state: Awaited<ReturnType<typeof listGlossaryEntries>> =
    (input.glossary_state as Awaited<ReturnType<typeof listGlossaryEntries>>) ??
    (await listGlossaryEntries(project_id));
  // Merge attached Lore-Book entries: project entries always win,
  // higher-priority Lore Books take precedence over lower-priority.
  glossary_state = await resolveProjectGlossaryWithLore(
    project_id,
    glossary_state,
  );

  const summary = createSummary();
  summary.total = pending.length;
  const started = performance.now();

  await appendEvent(project_id, "batch.started", {
    model: options.model,
    concurrency,
    budget_usd: effective_budget,
    segment_count: pending.length,
    chapter_ids: options.chapter_ids ?? null,
  });

  if (pending.length === 0) {
    summary.elapsed_s = (performance.now() - started) / 1000;
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
      // Pre-pass may have promoted new entries; refresh the snapshot
      // and re-merge attached Lore-Book entries.
      glossary_state = await resolveProjectGlossaryWithLore(
        project_id,
        await listGlossaryEntries(project_id),
      );
    }
  }

  // Sliding-window pool: fire `concurrency` workers; each pulls the
  // next segment off the cursor until the queue is empty, the budget
  // trips, or the curator cancels. Workers also handle their own
  // failure-isolation so one segment's exception doesn't sink the
  // others.
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (cancelled || paused) return;
      if (signal?.aborted) {
        cancelled = true;
        return;
      }
      const i = cursor++;
      if (i >= pending.length) return;
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
        const chapter_notes = await chapterNotesFor(seg.chapter_id);
        const outcome = await translateSegment({
          project_id,
          source_lang,
          target_lang,
          style_guide: effective_style_guide,
          chapter_notes,
          segment: seg,
          provider,
          options: {
            model: options.model,
            bypass_cache: options.bypass_cache,
            reasoning_effort: options.reasoning_effort ?? null,
            glossary_state: glossary_state,
            signal,
          },
        });
        applyOutcome(summary, outcome);
        const over_budget =
          effective_budget !== null &&
          effective_budget !== undefined &&
          summary.cost_usd > effective_budget;
        summary.elapsed_s = (performance.now() - started) / 1000;
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
      } catch (exc: unknown) {
        if (exc instanceof LLMRateLimitError) {
          if (!paused) {
            paused = true;
            pause_reason = formatRateLimitPause(exc);
          }
          // Don't fail the segment on a rate-limit; it stays pending
          // for the next run. The `finally` block fires on_segment_end.
          return;
        }
        if (signal?.aborted) {
          cancelled = true;
          return;
        }
        const msg = exc instanceof Error ? exc.message : String(exc);
        summary.failed += 1;
        summary.failures.push({ segment_id: seg_row.id, error: msg });
        await appendEvent(project_id, "batch.segment_failed", {
          segment_id: seg_row.id,
          chapter_id: seg_row.chapter_id,
          error: msg,
        });
        summary.elapsed_s = (performance.now() - started) / 1000;
        on_progress?.({
          segment_id: seg_row.id,
          chapter_id: seg_row.chapter_id,
          outcome: null,
          error: msg,
          summary: cloneSummary(summary),
        });
      } finally {
        try {
          on_segment_end?.({
            segment_id: seg.id,
            chapter_id: seg.chapter_id,
          });
        } catch {
          /* swallow */
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, () =>
      worker(),
    ),
  );

  summary.elapsed_s = (performance.now() - started) / 1000;

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
