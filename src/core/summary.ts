/**
 * Helper-LLM summary services (book + chapter premises).
 *
 * Two public flows live here, mirroring the extractor module's
 * shape:
 *
 *   - `runBookSummary` — drafts a 150-250 word premise from the
 *     opening segments of the book and writes it into
 *     `projects.book_summary`. Source-only (never the whole book) so
 *     early-chapter translator prompts don't get spoiler-leaked.
 *   - `runChapterSummary` — drafts a 50-120 word recap of one
 *     chapter and writes it into `chapters.notes`. Optionally seeded
 *     by the existing `book_summary` so the helper can keep
 *     cross-chapter continuity.
 *
 * Both flows fan out to `summarize`, which is the single
 * LLM-touching primitive: build the helper messages, look up the
 * cache, call the provider on a miss, parse the response, and
 * persist one `llm_call` row + a structured trace event.
 * `purpose="summarize"` keeps these helper rows distinct from both
 * the translator's audit trail and the extractor's.
 *
 * Hard rules respected here:
 *
 *   - **Cache hits never call the network.** The cache key folds the
 *     glossary state hash, so curator promotions invalidate stale
 *     summary traces just like translations.
 *   - **Per-call audit.** Every call (cache hit or miss) inserts an
 *     `llm_call` row with full prompt / response JSON.
 *   - **Best-effort, never blocks translation.** A malformed
 *     response is recorded as a `summary.failed` event and the
 *     intake_run row's `error` is filled in; the function still
 *     returns (the caller decides how to surface it).
 */

import { cacheKeyForMessages, EMPTY_GLOSSARY_HASH } from "@/core/cache";
import { openProjectDb } from "@/db/dexie";
import { listChapters, updateChapterNotes } from "@/db/repo/chapters";
import { listGlossaryEntries } from "@/db/repo/glossary";
import {
  attachIntakeRunEntries,
  recordIntakeRun,
} from "@/db/repo/intake";
import { findLlmCallByCacheKey, insertLlmCall } from "@/db/repo/llm_calls";
import { appendEvent, loadProject } from "@/db/repo/projects";
import {
  type ChapterRow,
  IntakeRunKind,
  type IntakeRunKindT,
  IntakeRunStatus,
  type IntakeRunStatusT,
  type SegmentRow,
} from "@/db/schema";
import { buildConstraints, glossaryHash } from "@/glossary/enforcer";
import type { GlossaryEntryWithAliases } from "@/glossary/models";
import {
  LLMResponseError,
  type LLMProvider,
  type ResponseFormat,
} from "@/llm/base";
import { chatWithJsonFallback } from "@/llm/json_mode";
import { estimateCost } from "@/llm/pricing";
import type { GlossaryConstraint } from "@/llm/prompts/translator";
import {
  buildBookSummaryMessages,
  buildChapterSummaryMessages,
  type BookSummaryTrace,
  type ChapterSummaryTrace,
  DEFAULT_SUMMARY_RESPONSE_FORMAT,
  parseBookSummaryResponse,
  parseChapterSummaryResponse,
} from "@/llm/prompts/summary";
import { countTokensSync } from "@/llm/tokens";
import { newId } from "@/lib/id";
import { stableStringify } from "@/lib/json";
import { nowMs } from "@/lib/time";

export const PURPOSE_SUMMARIZE = "summarize";

/**
 * Default segment cap when chunking the opening of the book for the
 * book-summary helper. Mirrors `runBookIntake`'s 30-segment ceiling
 * so we don't accidentally bleed plot beats from later chapters.
 */
export const DEFAULT_BOOK_SUMMARY_MAX_SEGMENTS = 30;

/**
 * Token budget per chunk. Wide enough that the typical opening of a
 * novel fits in one chunk; if it doesn't, we summarise per chunk and
 * use the LAST trace's payload (which was seeded by the prior
 * summary) as the canonical result.
 */
export const DEFAULT_SUMMARY_CHUNK_MAX_TOKENS = 4500;

/* ------------------------------------------------------------------ */
/* options                                                            */
/* ------------------------------------------------------------------ */

export interface SummaryOptions {
  model: string;
  temperature?: number | null;
  seed?: number | null;
  bypass_cache?: boolean;
  response_format?: ResponseFormat | null;
}

export interface RunBookSummaryOptions extends SummaryOptions {
  max_segments?: number;
  chunk_max_tokens?: number;
}

export interface RunChapterSummaryOptions extends SummaryOptions {
  chunk_max_tokens?: number;
}

/* ------------------------------------------------------------------ */
/* outcomes                                                           */
/* ------------------------------------------------------------------ */

interface BaseOutcome<T> {
  trace: T;
  cache_hit: boolean;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  llm_call_id: string;
  cache_key: string;
}

export type BookSummaryOutcome = BaseOutcome<BookSummaryTrace>;
export type ChapterSummaryOutcome = BaseOutcome<ChapterSummaryTrace>;

export interface BookSummaryResult {
  summary: string | null;
  trace: BookSummaryTrace | null;
  chunks: number;
  cached_chunks: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  failed_chunks: number;
  error: string | null;
  intake_run_id: string | null;
}

export interface ChapterSummaryResult {
  chapter_id: string;
  summary: string | null;
  trace: ChapterSummaryTrace | null;
  cache_hit: boolean;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  error: string | null;
  intake_run_id: string | null;
}

/* ------------------------------------------------------------------ */
/* progress callbacks                                                 */
/* ------------------------------------------------------------------ */

export interface BookSummaryChunkEvent {
  chunk_index: number;
  chunk_count: number;
  success: boolean;
  cache_hit: boolean;
  error: string | null;
}

export interface ChapterSummaryProgressEvent {
  chapter_index: number;
  chapter_count: number;
  chapter_id: string;
  success: boolean;
  cache_hit: boolean;
  error: string | null;
}

/* ------------------------------------------------------------------ */
/* summarizeBook                                                      */
/* ------------------------------------------------------------------ */

interface SummarizeBookInput {
  project_id: string;
  source_lang: string;
  target_lang: string;
  source_text: string;
  prior_summary: string | null;
  provider: LLMProvider;
  options: SummaryOptions;
  glossary?: ReadonlyArray<GlossaryEntryWithAliases>;
}

async function summarizeBook(
  input: SummarizeBookInput,
): Promise<BookSummaryOutcome> {
  return summarizeWith({
    project_id: input.project_id,
    purpose_label: "book",
    provider: input.provider,
    options: input.options,
    build: (glossary) =>
      buildBookSummaryMessages({
        source_lang: input.source_lang,
        target_lang: input.target_lang,
        source_text: input.source_text,
        glossary,
        prior_summary: input.prior_summary,
      }),
    parse: parseBookSummaryResponse,
    glossary_entries: input.glossary,
  });
}

/* ------------------------------------------------------------------ */
/* summarizeChapter                                                   */
/* ------------------------------------------------------------------ */

interface SummarizeChapterInput {
  project_id: string;
  source_lang: string;
  target_lang: string;
  source_text: string;
  book_summary: string | null;
  chapter_title: string | null;
  provider: LLMProvider;
  options: SummaryOptions;
  glossary?: ReadonlyArray<GlossaryEntryWithAliases>;
}

async function summarizeChapter(
  input: SummarizeChapterInput,
): Promise<ChapterSummaryOutcome> {
  return summarizeWith({
    project_id: input.project_id,
    purpose_label: "chapter",
    provider: input.provider,
    options: input.options,
    build: (glossary) =>
      buildChapterSummaryMessages({
        source_lang: input.source_lang,
        target_lang: input.target_lang,
        source_text: input.source_text,
        glossary,
        book_summary: input.book_summary,
        chapter_title: input.chapter_title,
      }),
    parse: parseChapterSummaryResponse,
    glossary_entries: input.glossary,
  });
}

/* ------------------------------------------------------------------ */
/* shared low-level helper                                            */
/* ------------------------------------------------------------------ */

interface SummarizeWithInput<T> {
  project_id: string;
  /** "book" or "chapter" — used in event payloads only. */
  purpose_label: "book" | "chapter";
  provider: LLMProvider;
  options: SummaryOptions;
  build: (
    glossary: ReadonlyArray<GlossaryConstraint>,
  ) => ReturnType<typeof buildBookSummaryMessages>;
  parse: (content: string) => T;
  glossary_entries?: ReadonlyArray<GlossaryEntryWithAliases>;
}

async function summarizeWith<T>(
  input: SummarizeWithInput<T>,
): Promise<BaseOutcome<T>> {
  const project_entries = input.glossary_entries
    ? [...input.glossary_entries]
    : await listGlossaryEntries(input.project_id);
  const constraints = buildConstraints(project_entries);
  const g_hash =
    (await glossaryHash(project_entries)) ?? EMPTY_GLOSSARY_HASH;
  const messages = input.build(constraints);

  let key = await cacheKeyForMessages({
    model: input.options.model,
    messages,
    glossary_hash: g_hash,
  });
  if (input.options.bypass_cache) key = `${key}:retry`;

  const request_payload = {
    model: input.options.model,
    purpose: PURPOSE_SUMMARIZE,
    label: input.purpose_label,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: input.options.temperature ?? null,
    seed: input.options.seed ?? null,
    glossary_hash: g_hash,
  };
  const request_json = stableStringify(request_payload);

  /* --- cache lookup ---------------------------------------------- */
  if (!input.options.bypass_cache) {
    const hit = await findLlmCallByCacheKey(input.project_id, key);
    if (hit && hit.response_json) {
      let parsed: T | null = null;
      try {
        const payload = JSON.parse(hit.response_json) as Record<string, unknown>;
        const trace_data = payload.trace;
        if (trace_data && typeof trace_data === "object" && !Array.isArray(trace_data)) {
          parsed = trace_data as T;
        } else if (typeof payload.content === "string") {
          parsed = input.parse(payload.content);
        }
      } catch {
        parsed = null;
      }
      if (parsed) {
        const new_id = newId();
        await insertLlmCall(input.project_id, {
          id: new_id,
          project_id: input.project_id,
          segment_id: null,
          purpose: PURPOSE_SUMMARIZE,
          model: hit.model,
          prompt_tokens: hit.prompt_tokens ?? 0,
          completion_tokens: hit.completion_tokens ?? 0,
          cost_usd: 0,
          cache_hit: true,
          cache_key: key,
          request_json,
          response_json: hit.response_json,
        });
        return {
          trace: parsed,
          cache_hit: true,
          prompt_tokens: hit.prompt_tokens ?? 0,
          completion_tokens: hit.completion_tokens ?? 0,
          cost_usd: 0,
          llm_call_id: new_id,
          cache_key: key,
        };
      }
    }
  }

  /* --- live call ------------------------------------------------- */
  const response_format =
    input.options.response_format === null
      ? undefined
      : (input.options.response_format ?? DEFAULT_SUMMARY_RESPONSE_FORMAT);
  const chat_result = await chatWithJsonFallback(input.provider, {
    messages,
    model: input.options.model,
    response_format,
    temperature: input.options.temperature ?? undefined,
    seed: input.options.seed ?? undefined,
  });

  let trace: T;
  try {
    trace = input.parse(chat_result.content);
  } catch (err) {
    if (!(err instanceof LLMResponseError)) throw err;
    await recordFailedSummary({
      project_id: input.project_id,
      label: input.purpose_label,
      model: chat_result.model,
      request_json,
      response_json: stableStringify({
        content: chat_result.content,
        raw: chat_result.raw,
      }),
      key,
      prompt_tokens: chat_result.usage?.prompt_tokens ?? 0,
      completion_tokens: chat_result.usage?.completion_tokens ?? 0,
    });
    throw err;
  }

  const prompt_tokens = chat_result.usage?.prompt_tokens ?? 0;
  const completion_tokens = chat_result.usage?.completion_tokens ?? 0;
  const cost_usd = estimateCost(
    chat_result.model,
    prompt_tokens,
    completion_tokens,
  );

  const llm_call_id = newId();
  const response_json = stableStringify({
    content: chat_result.content,
    trace,
    raw: chat_result.raw,
  });
  await insertLlmCall(input.project_id, {
    id: llm_call_id,
    project_id: input.project_id,
    segment_id: null,
    purpose: PURPOSE_SUMMARIZE,
    model: chat_result.model,
    prompt_tokens,
    completion_tokens,
    cost_usd,
    cache_hit: false,
    cache_key: key,
    request_json,
    response_json,
  });
  return {
    trace,
    cache_hit: false,
    prompt_tokens,
    completion_tokens,
    cost_usd,
    llm_call_id,
    cache_key: key,
  };
}

interface RecordFailedSummaryInput {
  project_id: string;
  label: "book" | "chapter";
  model: string;
  request_json: string;
  response_json: string;
  key: string;
  prompt_tokens: number;
  completion_tokens: number;
}

async function recordFailedSummary(
  input: RecordFailedSummaryInput,
): Promise<void> {
  const cost = estimateCost(
    input.model,
    input.prompt_tokens,
    input.completion_tokens,
  );
  const db = openProjectDb(input.project_id);
  await db.transaction("rw", db.llm_calls, db.events, async () => {
    await insertLlmCall(input.project_id, {
      id: newId(),
      project_id: input.project_id,
      segment_id: null,
      purpose: PURPOSE_SUMMARIZE,
      model: input.model,
      prompt_tokens: input.prompt_tokens,
      completion_tokens: input.completion_tokens,
      cost_usd: cost,
      cache_hit: false,
      cache_key: input.key,
      request_json: input.request_json,
      response_json: input.response_json,
    });
    await appendEvent(input.project_id, "summary.failed", {
      label: input.label,
      model: input.model,
    });
  });
}

/* ------------------------------------------------------------------ */
/* runBookSummary                                                     */
/* ------------------------------------------------------------------ */

export interface RunBookSummaryInput {
  project_id: string;
  source_lang: string;
  target_lang: string;
  provider: LLMProvider;
  options: RunBookSummaryOptions;
  on_chunk?: (ev: BookSummaryChunkEvent) => void;
}

export async function runBookSummary(
  input: RunBookSummaryInput,
): Promise<BookSummaryResult> {
  const max_segments =
    input.options.max_segments ?? DEFAULT_BOOK_SUMMARY_MAX_SEGMENTS;
  const chunk_max_tokens =
    input.options.chunk_max_tokens ?? DEFAULT_SUMMARY_CHUNK_MAX_TOKENS;
  const started_at = nowMs();
  const segments = await selectInitialSegments(input.project_id, max_segments);
  await appendEvent(input.project_id, "summary.book_started", {
    model: input.options.model,
    max_segments,
    chunk_max_tokens,
    segment_count: segments.length,
  });

  const result: BookSummaryResult = {
    summary: null,
    trace: null,
    chunks: 0,
    cached_chunks: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    failed_chunks: 0,
    error: null,
    intake_run_id: null,
  };

  if (segments.length === 0) {
    result.error = "no segments to summarise";
    await appendEvent(input.project_id, "summary.book_failed", {
      model: input.options.model,
      reason: result.error,
    });
    result.intake_run_id = await persistSummaryIntakeRun({
      project_id: input.project_id,
      kind: IntakeRunKind.BOOK_SUMMARY,
      helper_model: input.options.model,
      started_at,
      status: IntakeRunStatus.ABORTED,
      result,
    });
    return result;
  }

  const chunks = chunkSegments(segments, chunk_max_tokens);
  let prior_summary: string | null = null;
  let last_trace: BookSummaryTrace | null = null;

  for (let idx = 0; idx < chunks.length; idx += 1) {
    const chunk = chunks[idx]!;
    let outcome: BookSummaryOutcome | null = null;
    try {
      outcome = await summarizeBook({
        project_id: input.project_id,
        source_lang: input.source_lang,
        target_lang: input.target_lang,
        source_text: chunk,
        prior_summary,
        provider: input.provider,
        options: input.options,
      });
    } catch (err) {
      const msg = shortError(err);
      result.failed_chunks += 1;
      if (!result.error) result.error = msg;
      emitBookChunk(input.on_chunk, {
        chunk_index: idx,
        chunk_count: chunks.length,
        success: false,
        cache_hit: false,
        error: msg,
      });
      continue;
    }
    result.chunks += 1;
    result.prompt_tokens += outcome.prompt_tokens;
    result.completion_tokens += outcome.completion_tokens;
    result.cost_usd += outcome.cost_usd;
    if (outcome.cache_hit) result.cached_chunks += 1;
    last_trace = outcome.trace;
    prior_summary = outcome.trace.summary;
    emitBookChunk(input.on_chunk, {
      chunk_index: idx,
      chunk_count: chunks.length,
      success: true,
      cache_hit: outcome.cache_hit,
      error: null,
    });
  }

  if (last_trace) {
    result.trace = last_trace;
    result.summary = last_trace.summary;
    const db = openProjectDb(input.project_id);
    await db.projects.update(input.project_id, {
      book_summary: last_trace.summary,
    });
    await appendEvent(input.project_id, "summary.book_completed", {
      model: input.options.model,
      chunks: result.chunks,
      cached_chunks: result.cached_chunks,
      register: last_trace.register,
      audience: last_trace.audience,
    });
    result.intake_run_id = await persistSummaryIntakeRun({
      project_id: input.project_id,
      kind: IntakeRunKind.BOOK_SUMMARY,
      helper_model: input.options.model,
      started_at,
      status: IntakeRunStatus.COMPLETED,
      result,
      register: last_trace.register,
      audience: last_trace.audience,
      notes: last_trace.notes,
    });
  } else {
    if (!result.error) result.error = "all summary chunks failed";
    await appendEvent(input.project_id, "summary.book_failed", {
      model: input.options.model,
      reason: result.error,
    });
    result.intake_run_id = await persistSummaryIntakeRun({
      project_id: input.project_id,
      kind: IntakeRunKind.BOOK_SUMMARY,
      helper_model: input.options.model,
      started_at,
      status: IntakeRunStatus.ABORTED,
      result,
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* runChapterSummary                                                  */
/* ------------------------------------------------------------------ */

export interface RunChapterSummaryInput {
  project_id: string;
  source_lang: string;
  target_lang: string;
  provider: LLMProvider;
  options: RunChapterSummaryOptions;
  /** Pass a single id to summarise that chapter; omit for "all chapters". */
  chapter_id?: string;
  /**
   * When `chapter_id` is omitted, only generate for chapters whose
   * `notes` field is empty. Defaults to `false` (regenerate every
   * chapter — matches "Regenerate all" in the UI).
   */
  only_missing?: boolean;
  on_progress?: (ev: ChapterSummaryProgressEvent) => void;
}

export async function runChapterSummary(
  input: RunChapterSummaryInput,
): Promise<ChapterSummaryResult[]> {
  const all = await listChapters(input.project_id);
  let chapters: ChapterRow[];
  if (input.chapter_id) {
    const found = all.find((c) => c.id === input.chapter_id);
    if (!found) {
      throw new Error(`chapter not found: ${input.chapter_id}`);
    }
    chapters = [found];
  } else if (input.only_missing) {
    chapters = all.filter((c) => !c.notes || !c.notes.trim());
  } else {
    chapters = [...all];
  }

  const results: ChapterSummaryResult[] = [];
  if (chapters.length === 0) return results;

  const project = await loadProject(input.project_id);
  const book_summary = project.book_summary?.trim() || null;
  const project_entries = await listGlossaryEntries(input.project_id);

  for (let idx = 0; idx < chapters.length; idx += 1) {
    const chapter = chapters[idx]!;
    const started_at = nowMs();
    const segs = await loadChapterSegments(input.project_id, chapter.id);
    const source_text = segs
      .map((s) => s.source_text.trim())
      .filter((s) => s.length > 0)
      .join("\n\n");

    const partial: ChapterSummaryResult = {
      chapter_id: chapter.id,
      summary: null,
      trace: null,
      cache_hit: false,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      error: null,
      intake_run_id: null,
    };

    if (!source_text.trim()) {
      partial.error = "chapter has no source text";
      await appendEvent(input.project_id, "summary.chapter_failed", {
        chapter_id: chapter.id,
        reason: partial.error,
      });
      partial.intake_run_id = await persistChapterSummaryIntakeRun({
        project_id: input.project_id,
        chapter_id: chapter.id,
        helper_model: input.options.model,
        started_at,
        status: IntakeRunStatus.ABORTED,
        partial,
      });
      results.push(partial);
      emitChapterProgress(input.on_progress, {
        chapter_index: idx,
        chapter_count: chapters.length,
        chapter_id: chapter.id,
        success: false,
        cache_hit: false,
        error: partial.error,
      });
      continue;
    }

    let outcome: ChapterSummaryOutcome | null = null;
    try {
      outcome = await summarizeChapter({
        project_id: input.project_id,
        source_lang: input.source_lang,
        target_lang: input.target_lang,
        source_text,
        book_summary,
        chapter_title: chapter.title,
        provider: input.provider,
        options: input.options,
        glossary: project_entries,
      });
    } catch (err) {
      partial.error = shortError(err);
      await appendEvent(input.project_id, "summary.chapter_failed", {
        chapter_id: chapter.id,
        reason: partial.error,
      });
      partial.intake_run_id = await persistChapterSummaryIntakeRun({
        project_id: input.project_id,
        chapter_id: chapter.id,
        helper_model: input.options.model,
        started_at,
        status: IntakeRunStatus.ABORTED,
        partial,
      });
      results.push(partial);
      emitChapterProgress(input.on_progress, {
        chapter_index: idx,
        chapter_count: chapters.length,
        chapter_id: chapter.id,
        success: false,
        cache_hit: false,
        error: partial.error,
      });
      continue;
    }

    partial.trace = outcome.trace;
    partial.summary = outcome.trace.summary;
    partial.cache_hit = outcome.cache_hit;
    partial.prompt_tokens = outcome.prompt_tokens;
    partial.completion_tokens = outcome.completion_tokens;
    partial.cost_usd = outcome.cost_usd;

    await updateChapterNotes(input.project_id, chapter.id, outcome.trace.summary);
    await appendEvent(input.project_id, "summary.chapter_completed", {
      chapter_id: chapter.id,
      model: input.options.model,
      cache_hit: outcome.cache_hit,
      pov_shift: outcome.trace.pov_shift,
      scene_label: outcome.trace.scene_label,
    });
    partial.intake_run_id = await persistChapterSummaryIntakeRun({
      project_id: input.project_id,
      chapter_id: chapter.id,
      helper_model: input.options.model,
      started_at,
      status: IntakeRunStatus.COMPLETED,
      partial,
      pov_shift: outcome.trace.pov_shift,
      scene_label: outcome.trace.scene_label,
    });
    results.push(partial);
    emitChapterProgress(input.on_progress, {
      chapter_index: idx,
      chapter_count: chapters.length,
      chapter_id: chapter.id,
      success: true,
      cache_hit: outcome.cache_hit,
      error: null,
    });
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

interface PersistBookIntakeRunInput {
  project_id: string;
  kind: IntakeRunKindT;
  helper_model: string;
  started_at: number;
  status: IntakeRunStatusT;
  result: BookSummaryResult;
  register?: string | null;
  audience?: string | null;
  notes?: string | null;
}

async function persistSummaryIntakeRun(
  input: PersistBookIntakeRunInput,
): Promise<string | null> {
  try {
    const row = await recordIntakeRun({
      project_id: input.project_id,
      kind: input.kind,
      chapter_id: null,
      helper_model: input.helper_model,
      started_at: input.started_at,
      finished_at: nowMs(),
      status: input.status,
      chunks: input.result.chunks,
      cached_chunks: input.result.cached_chunks,
      proposed_count: 0,
      failed_chunks: input.result.failed_chunks,
      prompt_tokens: input.result.prompt_tokens,
      completion_tokens: input.result.completion_tokens,
      cost_usd: input.result.cost_usd,
      pov: null,
      tense: null,
      narrative_register: input.register ?? null,
      audience: input.audience ?? null,
      suggested_style_profile: null,
      notes: input.notes ? [input.notes] : [],
      error: input.result.error,
    });
    return row.id;
  } catch {
    return null;
  }
}

interface PersistChapterIntakeRunInput {
  project_id: string;
  chapter_id: string;
  helper_model: string;
  started_at: number;
  status: IntakeRunStatusT;
  partial: ChapterSummaryResult;
  pov_shift?: string | null;
  scene_label?: string | null;
}

async function persistChapterSummaryIntakeRun(
  input: PersistChapterIntakeRunInput,
): Promise<string | null> {
  try {
    const notes: string[] = [];
    if (input.scene_label) notes.push(`scene: ${input.scene_label}`);
    if (input.pov_shift) notes.push(`pov: ${input.pov_shift}`);
    const row = await recordIntakeRun({
      project_id: input.project_id,
      kind: IntakeRunKind.CHAPTER_SUMMARY,
      chapter_id: input.chapter_id,
      helper_model: input.helper_model,
      started_at: input.started_at,
      finished_at: nowMs(),
      status: input.status,
      chunks: input.partial.summary ? 1 : 0,
      cached_chunks: input.partial.cache_hit ? 1 : 0,
      proposed_count: 0,
      failed_chunks: input.partial.summary ? 0 : 1,
      prompt_tokens: input.partial.prompt_tokens,
      completion_tokens: input.partial.completion_tokens,
      cost_usd: input.partial.cost_usd,
      pov: null,
      tense: null,
      narrative_register: null,
      audience: null,
      suggested_style_profile: null,
      notes,
      error: input.partial.error,
    });
    void attachIntakeRunEntries; // keep import alive when no entries are linked
    return row.id;
  } catch {
    return null;
  }
}

function shortError(exc: unknown): string {
  const text = exc instanceof Error ? exc.message : String(exc);
  if (text.length <= 240) return text;
  return text.slice(0, 239) + "\u2026";
}

function emitBookChunk(
  cb: ((ev: BookSummaryChunkEvent) => void) | undefined,
  ev: BookSummaryChunkEvent,
): void {
  if (!cb) return;
  try {
    cb(ev);
  } catch {
    // best-effort
  }
}

function emitChapterProgress(
  cb: ((ev: ChapterSummaryProgressEvent) => void) | undefined,
  ev: ChapterSummaryProgressEvent,
): void {
  if (!cb) return;
  try {
    cb(ev);
  } catch {
    // best-effort
  }
}

function chunkSegments(
  segments: SegmentRow[],
  chunk_max_tokens: number,
): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let current_tokens = 0;
  for (const seg of segments) {
    const text = seg.source_text.trim();
    if (!text) continue;
    const seg_tokens = Math.max(1, countTokensSync(text));
    if (current.length && current_tokens + seg_tokens > chunk_max_tokens) {
      chunks.push(current.join("\n\n"));
      current = [];
      current_tokens = 0;
    }
    current.push(text);
    current_tokens += seg_tokens;
  }
  if (current.length) chunks.push(current.join("\n\n"));
  return chunks;
}

async function selectInitialSegments(
  project_id: string,
  max_segments: number,
): Promise<SegmentRow[]> {
  if (max_segments <= 0) return [];
  const db = openProjectDb(project_id);
  const rows = await db.segments.toArray();
  const chapters = await db.chapters.toArray();
  const order = new Map(chapters.map((c) => [c.id, c.spine_idx]));
  rows.sort((a, b) => {
    const sa = order.get(a.chapter_id) ?? 0;
    const sb = order.get(b.chapter_id) ?? 0;
    if (sa !== sb) return sa - sb;
    return a.idx - b.idx;
  });
  return rows.slice(0, max_segments);
}

async function loadChapterSegments(
  project_id: string,
  chapter_id: string,
): Promise<SegmentRow[]> {
  const db = openProjectDb(project_id);
  const rows = await db.segments
    .where("chapter_id")
    .equals(chapter_id)
    .toArray();
  rows.sort((a, b) => a.idx - b.idx);
  return rows;
}
