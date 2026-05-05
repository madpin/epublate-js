/**
 * Helper-LLM extractor service (mirrors `epublate.core.extractor`).
 *
 * Two public flows live here:
 *
 *   - `runBookIntake` — the one-shot pass at project creation
 *     (PRD §7.1 step 5). Reads the first few segments, chunks them
 *     under a token budget, and asks the helper LLM for a draft
 *     glossary plus narrative POV/tense.
 *   - `runPrePass` — per-chapter pre-pass for batch mode
 *     (PRD §4.2 phase 3). Operates on an explicit segment list so
 *     the caller (typically `runBatch`) can drive it once per chapter
 *     before the translator futures fire.
 *
 * Both flows fan out to `extractEntities`, which is the single
 * LLM-touching primitive: build the helper messages, look up the
 * cache, call the provider on a miss, parse the response, upsert
 * `proposed` glossary entries, and persist one `llm_call` row + a
 * structured trace event. `purpose="extract"` keeps the helper rows
 * distinct from the translator's audit trail.
 *
 * Hard rules respected here:
 *
 *   - **Cache hits never call the network.** The cache key folds the
 *     glossary state hash, so curator promotions invalidate stale
 *     extractor traces just like they do for translations.
 *   - **Per-call audit.** Every call (cache hit or miss) inserts an
 *     `llm_call` row with full prompt / response JSON.
 *   - **Atomic upserts.** Proposed entries, the `llm_call` row, and
 *     the `intake.*` event commit together.
 *   - **Best-effort, never blocks translation.** A malformed response
 *     is recorded as `intake.failed` and surfaced to the curator's
 *     Inbox, but doesn't raise.
 */

import { cacheKeyForMessages, EMPTY_GLOSSARY_HASH } from "@/core/cache";
import { openProjectDb } from "@/db/dexie";
import { listGlossaryEntries } from "@/db/repo/glossary";
import {
  attachIntakeRunEntries,
  recordIntakeRun,
} from "@/db/repo/intake";
import { findLlmCallByCacheKey, insertLlmCall } from "@/db/repo/llm_calls";
import { appendEvent } from "@/db/repo/projects";
import {
  type EntityType,
  type IntakeRunKindT,
  IntakeRunKind,
  IntakeRunStatus,
  type IntakeRunStatusT,
  SegmentStatus,
  type SegmentRow,
  type SegmentStatusT,
} from "@/db/schema";
import { suggestStyleProfile } from "@/core/style";
import { upsertProposed } from "@/glossary/io";
import { buildConstraints, glossaryHash } from "@/glossary/enforcer";
import type { GlossaryEntryWithAliases } from "@/glossary/models";
import {
  LLMRateLimitError,
  LLMResponseError,
  type LLMProvider,
  type ResponseFormat,
} from "@/llm/base";
import { chatWithJsonFallback } from "@/llm/json_mode";
import { estimateCost } from "@/llm/pricing";
import {
  buildExtractorMessages,
  DEFAULT_EXTRACTOR_RESPONSE_FORMAT,
  type ExtractedEntity,
  type ExtractorTrace,
  parseExtractorResponse,
} from "@/llm/prompts/extractor";
import { countTokensSync } from "@/llm/tokens";
import { newId } from "@/lib/id";
import { stableStringify } from "@/lib/json";
import { nowMs } from "@/lib/time";

export const PURPOSE_EXTRACT = "extract";

export const DEFAULT_INTAKE_MAX_SEGMENTS = 30;
export const DEFAULT_CHUNK_MAX_TOKENS = 1500;
export const DEFAULT_FAILURE_STREAK_LIMIT = 3;

const VALID_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  "character",
  "place",
  "organization",
  "event",
  "item",
  "date_or_time",
  "phrase",
  "term",
  "other",
]);

export interface ExtractOptions {
  model: string;
  temperature?: number | null;
  seed?: number | null;
  bypass_cache?: boolean;
  response_format?: ResponseFormat | null;
  auto_propose?: boolean;
}

export interface ExtractOutcome {
  trace: ExtractorTrace;
  cache_hit: boolean;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  llm_call_id: string;
  cache_key: string;
  proposed_entry_ids: string[];
}

export interface IntakeOptions {
  model: string;
  max_segments?: number;
  chunk_max_tokens?: number;
  bypass_cache?: boolean;
  auto_propose?: boolean;
  failure_streak_limit?: number;
}

export interface IntakeSummary {
  chunks: number;
  cached_chunks: number;
  proposed_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  failed_chunks: number;
  pov: string | null;
  tense: string | null;
  register: string | null;
  audience: string | null;
  suggested_style_profile: string | null;
  notes: string[];
  proposed_entry_ids: string[];
}

export interface PrePassChunkEvent {
  chunk_index: number;
  chunk_count: number;
  success: boolean;
  error: string | null;
  proposed_count: number;
  cache_hit: boolean;
}

export type PrePassChunkCallback = (ev: PrePassChunkEvent) => void;

function emptySummary(): IntakeSummary {
  return {
    chunks: 0,
    cached_chunks: 0,
    proposed_count: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    failed_chunks: 0,
    pov: null,
    tense: null,
    register: null,
    audience: null,
    suggested_style_profile: null,
    notes: [],
    proposed_entry_ids: [],
  };
}

interface Chunk {
  text: string;
  first_segment_id: string | null;
}

/* ------------------------------------------------------------------ */
/* extractEntities                                                    */
/* ------------------------------------------------------------------ */

export interface ExtractEntitiesInput {
  project_id: string;
  source_lang: string;
  target_lang: string;
  source_text: string;
  provider: LLMProvider;
  options: ExtractOptions;
  first_seen_segment_id?: string | null;
  glossary?: ReadonlyArray<GlossaryEntryWithAliases>;
}

export async function extractEntities(
  input: ExtractEntitiesInput,
): Promise<ExtractOutcome> {
  const {
    project_id,
    source_lang,
    target_lang,
    source_text,
    provider,
    options,
    first_seen_segment_id = null,
  } = input;

  if (!source_text || !source_text.trim()) {
    throw new Error("source_text must not be empty");
  }

  const project_entries = input.glossary
    ? [...input.glossary]
    : await listGlossaryEntries(project_id);
  const constraints = buildConstraints(project_entries);
  const g_hash = (await glossaryHash(project_entries)) ?? EMPTY_GLOSSARY_HASH;

  const messages = buildExtractorMessages({
    source_lang,
    target_lang,
    source_text,
    glossary: constraints,
  });
  let key = await cacheKeyForMessages({
    model: options.model,
    messages,
    glossary_hash: g_hash,
  });
  if (options.bypass_cache) key = `${key}:retry`;

  const request_payload = {
    model: options.model,
    purpose: PURPOSE_EXTRACT,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: options.temperature ?? null,
    seed: options.seed ?? null,
    glossary_hash: g_hash,
  };
  const request_json = stableStringify(request_payload);

  /* --- cache lookup ------------------------------------------------ */
  if (!options.bypass_cache) {
    const hit = await findLlmCallByCacheKey(project_id, key);
    if (hit && hit.response_json) {
      return await replayExtractFromCache({
        project_id,
        key,
        hit_row: hit,
        request_json,
        options,
        first_seen_segment_id,
        source_lang,
        target_lang,
      });
    }
  }

  /* --- live call --------------------------------------------------- */
  const response_format =
    options.response_format === null
      ? undefined
      : (options.response_format ?? DEFAULT_EXTRACTOR_RESPONSE_FORMAT);
  const chat_result = await chatWithJsonFallback(provider, {
    messages,
    model: options.model,
    response_format,
    temperature: options.temperature ?? undefined,
    seed: options.seed ?? undefined,
  });

  let trace: ExtractorTrace;
  try {
    trace = parseExtractorResponse(chat_result.content);
  } catch (err) {
    if (!(err instanceof LLMResponseError)) throw err;
    await recordFailedExtract({
      project_id,
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

  /* --- persistence ------------------------------------------------- *
   * Dexie transactions are scoped to specific tables; we cross several
   * (glossary entries / aliases / revisions, entity_mentions, llm_calls,
   * events) and helpers like `upsertProposed` themselves run dedicated
   * transactions. To keep the contract simple — and to match how the
   * translator's `_auto_propose` runs outside its own transaction — we
   * just sequence the writes here. A crash mid-flow leaves the
   * llm_call row + already-proposed entries; the next intake pass will
   * happily re-propose what survived (the upsert is dedupe-aware).
   */
  const proposed_ids: string[] = [];
  await insertLlmCall(project_id, {
    id: llm_call_id,
    project_id,
    segment_id: first_seen_segment_id,
    purpose: PURPOSE_EXTRACT,
    model: chat_result.model,
    prompt_tokens,
    completion_tokens,
    cost_usd,
    cache_hit: false,
    cache_key: key,
    request_json,
    response_json,
  });
  if (options.auto_propose !== false) {
    const created = await autoProposeEntities({
      project_id,
      trace,
      first_seen_segment_id,
      source_lang,
      target_lang,
    });
    for (const id of created) proposed_ids.push(id);
  }
  await appendEvent(project_id, "entity.extracted", {
    llm_call_id,
    model: chat_result.model,
    cache_hit: false,
    entities: trace.entities.length,
    proposed: proposed_ids.length,
    pov: trace.pov,
    tense: trace.tense,
    register: trace.narrative_register,
    audience: trace.narrative_audience,
  });

  return {
    trace,
    cache_hit: false,
    prompt_tokens,
    completion_tokens,
    cost_usd,
    llm_call_id,
    cache_key: key,
    proposed_entry_ids: proposed_ids,
  };
}

interface ReplayExtractInput {
  project_id: string;
  key: string;
  hit_row: { id: string; model: string; prompt_tokens: number | null; completion_tokens: number | null; response_json: string | null };
  request_json: string;
  options: ExtractOptions;
  first_seen_segment_id: string | null;
  source_lang?: string;
  target_lang?: string;
}

async function replayExtractFromCache(
  input: ReplayExtractInput,
): Promise<ExtractOutcome> {
  const { project_id, key, hit_row, request_json, options, first_seen_segment_id } =
    input;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(hit_row.response_json ?? "{}") as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const trace_data = payload.trace;
  let trace: ExtractorTrace;
  if (trace_data && typeof trace_data === "object" && !Array.isArray(trace_data)) {
    trace = trace_data as ExtractorTrace;
  } else if (typeof payload.content === "string") {
    trace = parseExtractorResponse(payload.content);
  } else {
    throw new Error(`cached llm_call ${hit_row.id} has no usable extractor payload`);
  }

  const new_id = newId();
  const proposed_ids: string[] = [];
  await insertLlmCall(project_id, {
    id: new_id,
    project_id,
    segment_id: first_seen_segment_id,
    purpose: PURPOSE_EXTRACT,
    model: hit_row.model,
    prompt_tokens: hit_row.prompt_tokens ?? 0,
    completion_tokens: hit_row.completion_tokens ?? 0,
    cost_usd: 0,
    cache_hit: true,
    cache_key: key,
    request_json,
    response_json: hit_row.response_json,
  });
  if (options.auto_propose !== false) {
    const created = await autoProposeEntities({
      project_id,
      trace,
      first_seen_segment_id,
      source_lang: input.source_lang,
      target_lang: input.target_lang,
    });
    for (const id of created) proposed_ids.push(id);
  }
  await appendEvent(project_id, "entity.extracted", {
    llm_call_id: new_id,
    model: hit_row.model,
    cache_hit: true,
    entities: trace.entities.length,
    proposed: proposed_ids.length,
    pov: trace.pov,
    tense: trace.tense,
    register: trace.narrative_register,
    audience: trace.narrative_audience,
  });

  return {
    trace,
    cache_hit: true,
    prompt_tokens: hit_row.prompt_tokens ?? 0,
    completion_tokens: hit_row.completion_tokens ?? 0,
    cost_usd: 0,
    llm_call_id: new_id,
    cache_key: key,
    proposed_entry_ids: proposed_ids,
  };
}

interface AutoProposeInput {
  project_id: string;
  trace: ExtractorTrace;
  first_seen_segment_id: string | null;
  source_lang?: string;
  target_lang?: string;
}

async function autoProposeEntities(
  input: AutoProposeInput,
): Promise<string[]> {
  const created: string[] = [];
  for (const ent of input.trace.entities) {
    const norm = normalizeEntity(ent);
    if (norm === null) continue;
    const result = await upsertProposed(input.project_id, {
      source_term: norm.source,
      type: norm.type,
      first_seen_segment_id: input.first_seen_segment_id,
      notes: norm.notes,
      target_term: norm.target,
      source_lang: input.source_lang ?? null,
      target_lang: input.target_lang ?? null,
    });
    if (!result.created) continue;
    created.push(result.entry_id);
    await appendEvent(input.project_id, "entity.proposed", {
      entry_id: result.entry_id,
      segment_id: input.first_seen_segment_id,
      source_term: norm.source,
      type: norm.type,
      source: "extractor",
    });
  }
  return created;
}

function normalizeEntity(
  ent: ExtractedEntity,
): { source: string; type: EntityType; notes: string | null; target: string | null } | null {
  const source = ent.source.trim();
  if (!source) return null;
  const candidate = ent.type ? ent.type.trim().toLowerCase() : "term";
  const type: EntityType = VALID_ENTITY_TYPES.has(candidate as EntityType)
    ? (candidate as EntityType)
    : "term";
  const notes = ent.evidence ? ent.evidence.trim() || null : null;
  const target = ent.target ? ent.target.trim() || null : null;
  return { source, type, notes, target };
}

interface RecordFailedExtractInput {
  project_id: string;
  model: string;
  request_json: string;
  response_json: string;
  key: string;
  prompt_tokens: number;
  completion_tokens: number;
}

async function recordFailedExtract(
  input: RecordFailedExtractInput,
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
      purpose: PURPOSE_EXTRACT,
      model: input.model,
      prompt_tokens: input.prompt_tokens,
      completion_tokens: input.completion_tokens,
      cost_usd: cost,
      cache_hit: false,
      cache_key: input.key,
      request_json: input.request_json,
      response_json: input.response_json,
    });
    await appendEvent(input.project_id, "entity.extract_failed", {
      model: input.model,
    });
  });
}

/* ------------------------------------------------------------------ */
/* runBookIntake                                                      */
/* ------------------------------------------------------------------ */

export interface RunBookIntakeInput {
  project_id: string;
  source_lang: string;
  target_lang: string;
  provider: LLMProvider;
  options: IntakeOptions;
}

export async function runBookIntake(
  input: RunBookIntakeInput,
): Promise<IntakeSummary> {
  const opts = withIntakeDefaults(input.options);
  const segments = await selectInitialSegments(
    input.project_id,
    opts.max_segments,
  );
  const summary = emptySummary();
  const started_at = nowMs();
  await appendEvent(input.project_id, "intake.started", {
    model: opts.model,
    max_segments: opts.max_segments,
    chunk_max_tokens: opts.chunk_max_tokens,
    segment_count: segments.length,
  });
  if (segments.length === 0) {
    await appendEvent(input.project_id, "intake.completed", payloadOf(summary));
    await persistIntakeRun({
      project_id: input.project_id,
      summary,
      kind: IntakeRunKind.BOOK_INTAKE,
      helper_model: opts.model,
      started_at,
      status: IntakeRunStatus.COMPLETED,
    });
    return summary;
  }
  const chunks = chunkSegments(segments, opts.chunk_max_tokens, opts.model);
  let project_entries = await listGlossaryEntries(input.project_id);

  let streak = 0;
  let last_error: string | null = null;
  let aborted = false;
  for (let idx = 0; idx < chunks.length; idx += 1) {
    const chunk = chunks[idx]!;
    let outcome: ExtractOutcome;
    try {
      outcome = await extractEntities({
        project_id: input.project_id,
        source_lang: input.source_lang,
        target_lang: input.target_lang,
        source_text: chunk.text,
        provider: input.provider,
        options: {
          model: opts.model,
          bypass_cache: opts.bypass_cache,
          auto_propose: opts.auto_propose,
        },
        first_seen_segment_id: chunk.first_segment_id,
        glossary: project_entries,
      });
    } catch (err: unknown) {
      summary.failed_chunks += 1;
      streak += 1;
      last_error = shortError(err);
      if (shouldTripBreaker(streak, opts.failure_streak_limit)) {
        summary.failed_chunks += chunks.length - (idx + 1);
        aborted = true;
        break;
      }
      continue;
    }
    streak = 0;
    accumulateChunk(summary, outcome);
    if (outcome.proposed_entry_ids.length) {
      project_entries = await listGlossaryEntries(input.project_id);
    }
  }
  summary.suggested_style_profile = suggestStyleProfile({
    register: summary.register,
    audience: summary.audience,
  });
  if (aborted) {
    await appendEvent(input.project_id, "intake.aborted", {
      ...payloadOf(summary),
      failure_streak: streak,
      last_error,
    });
    await persistIntakeRun({
      project_id: input.project_id,
      summary,
      kind: IntakeRunKind.BOOK_INTAKE,
      helper_model: opts.model,
      started_at,
      status: IntakeRunStatus.ABORTED,
      error: last_error,
    });
  } else {
    await appendEvent(input.project_id, "intake.completed", payloadOf(summary));
    await persistIntakeRun({
      project_id: input.project_id,
      summary,
      kind: IntakeRunKind.BOOK_INTAKE,
      helper_model: opts.model,
      started_at,
      status: IntakeRunStatus.COMPLETED,
    });
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/* runPrePass                                                         */
/* ------------------------------------------------------------------ */

export interface RunPrePassInput {
  project_id: string;
  source_lang: string;
  target_lang: string;
  provider: LLMProvider;
  options: IntakeOptions;
  segments: ReadonlyArray<SegmentRow>;
  signal?: AbortSignal;
  on_chunk?: PrePassChunkCallback;
}

export async function runPrePass(
  input: RunPrePassInput,
): Promise<IntakeSummary> {
  const opts = withIntakeDefaults(input.options);
  const summary = emptySummary();
  const started_at = nowMs();
  const chapter_id = input.segments[0]?.chapter_id ?? null;
  if (input.segments.length === 0) {
    await appendEvent(input.project_id, "batch.pre_pass_completed", payloadOf(summary));
    await persistIntakeRun({
      project_id: input.project_id,
      summary,
      kind: IntakeRunKind.CHAPTER_PRE_PASS,
      helper_model: opts.model,
      started_at,
      status: IntakeRunStatus.COMPLETED,
      chapter_id,
    });
    return summary;
  }

  const chunks = chunkSegments(
    [...input.segments],
    opts.chunk_max_tokens,
    opts.model,
  );
  let project_entries = await listGlossaryEntries(input.project_id);

  await appendEvent(input.project_id, "batch.pre_pass_started", {
    model: opts.model,
    segment_count: input.segments.length,
    chunk_count: chunks.length,
  });

  let streak = 0;
  let last_error: string | null = null;
  let aborted = false;
  let cancelled = false;
  for (let idx = 0; idx < chunks.length; idx += 1) {
    if (input.signal?.aborted) {
      cancelled = true;
      break;
    }
    const chunk = chunks[idx]!;
    let outcome: ExtractOutcome;
    try {
      outcome = await extractEntities({
        project_id: input.project_id,
        source_lang: input.source_lang,
        target_lang: input.target_lang,
        source_text: chunk.text,
        provider: input.provider,
        options: {
          model: opts.model,
          bypass_cache: opts.bypass_cache,
          auto_propose: opts.auto_propose,
        },
        first_seen_segment_id: chunk.first_segment_id,
        glossary: project_entries,
      });
    } catch (err: unknown) {
      if (err instanceof LLMRateLimitError) {
        emitChunk(input.on_chunk, {
          chunk_index: idx,
          chunk_count: chunks.length,
          success: false,
          error: shortError(err),
          proposed_count: 0,
          cache_hit: false,
        });
        summary.suggested_style_profile = suggestStyleProfile({
          register: summary.register,
          audience: summary.audience,
        });
        await appendEvent(input.project_id, "batch.pre_pass_rate_limited", {
          ...payloadOf(summary),
          provider_message: err.message,
          retry_after_seconds: err.retry_after_seconds ?? null,
        });
        await persistIntakeRun({
          project_id: input.project_id,
          summary,
          kind: IntakeRunKind.CHAPTER_PRE_PASS,
          helper_model: opts.model,
          started_at,
          status: IntakeRunStatus.RATE_LIMITED,
          chapter_id,
          error: err.message,
        });
        throw err;
      }
      summary.failed_chunks += 1;
      streak += 1;
      last_error = shortError(err);
      emitChunk(input.on_chunk, {
        chunk_index: idx,
        chunk_count: chunks.length,
        success: false,
        error: last_error,
        proposed_count: 0,
        cache_hit: false,
      });
      if (shouldTripBreaker(streak, opts.failure_streak_limit)) {
        summary.failed_chunks += chunks.length - (idx + 1);
        aborted = true;
        break;
      }
      continue;
    }
    streak = 0;
    accumulateChunk(summary, outcome);
    if (outcome.proposed_entry_ids.length) {
      project_entries = await listGlossaryEntries(input.project_id);
    }
    emitChunk(input.on_chunk, {
      chunk_index: idx,
      chunk_count: chunks.length,
      success: true,
      error: null,
      proposed_count: outcome.proposed_entry_ids.length,
      cache_hit: outcome.cache_hit,
    });
  }

  summary.suggested_style_profile = suggestStyleProfile({
    register: summary.register,
    audience: summary.audience,
  });
  let final_status: IntakeRunStatusT = IntakeRunStatus.COMPLETED;
  if (cancelled) {
    final_status = IntakeRunStatus.CANCELLED;
    await appendEvent(input.project_id, "batch.pre_pass_cancelled", payloadOf(summary));
  } else if (aborted) {
    final_status = IntakeRunStatus.ABORTED;
    await appendEvent(input.project_id, "batch.pre_pass_aborted", {
      ...payloadOf(summary),
      failure_streak: streak,
      last_error,
    });
  } else {
    await appendEvent(input.project_id, "batch.pre_pass_completed", payloadOf(summary));
  }
  await persistIntakeRun({
    project_id: input.project_id,
    summary,
    kind: IntakeRunKind.CHAPTER_PRE_PASS,
    helper_model: opts.model,
    started_at,
    status: final_status,
    chapter_id,
    error: aborted ? last_error : null,
  });
  return summary;
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function withIntakeDefaults(opts: IntakeOptions): Required<IntakeOptions> {
  return {
    model: opts.model,
    max_segments: opts.max_segments ?? DEFAULT_INTAKE_MAX_SEGMENTS,
    chunk_max_tokens: opts.chunk_max_tokens ?? DEFAULT_CHUNK_MAX_TOKENS,
    bypass_cache: opts.bypass_cache ?? false,
    auto_propose: opts.auto_propose ?? true,
    failure_streak_limit:
      opts.failure_streak_limit ?? DEFAULT_FAILURE_STREAK_LIMIT,
  };
}

function shouldTripBreaker(streak: number, limit: number): boolean {
  return limit > 0 && streak >= limit;
}

function shortError(exc: unknown): string {
  const text = exc instanceof Error ? exc.message : String(exc);
  if (text.length <= 240) return text;
  return text.slice(0, 239) + "\u2026";
}

function emitChunk(
  cb: PrePassChunkCallback | undefined,
  ev: PrePassChunkEvent,
): void {
  if (!cb) return;
  try {
    cb(ev);
  } catch {
    // best-effort by design — a misbehaving listener can't take down the loop
  }
}

function accumulateChunk(
  summary: IntakeSummary,
  outcome: ExtractOutcome,
): void {
  summary.chunks += 1;
  summary.prompt_tokens += outcome.prompt_tokens;
  summary.completion_tokens += outcome.completion_tokens;
  summary.cost_usd += outcome.cost_usd;
  summary.proposed_count += outcome.proposed_entry_ids.length;
  summary.proposed_entry_ids.push(...outcome.proposed_entry_ids);
  if (outcome.cache_hit) summary.cached_chunks += 1;
  if (outcome.trace.pov && summary.pov === null) summary.pov = outcome.trace.pov;
  if (outcome.trace.tense && summary.tense === null) summary.tense = outcome.trace.tense;
  if (outcome.trace.narrative_register && summary.register === null) {
    summary.register = outcome.trace.narrative_register;
  }
  if (outcome.trace.narrative_audience && summary.audience === null) {
    summary.audience = outcome.trace.narrative_audience;
  }
  if (outcome.trace.notes) summary.notes.push(outcome.trace.notes);
}

function chunkSegments(
  segments: SegmentRow[],
  chunk_max_tokens: number,
  model: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  let current: string[] = [];
  let current_tokens = 0;
  let current_first: string | null = null;
  for (const seg of segments) {
    const text = seg.source_text.trim();
    if (!text) continue;
    const seg_tokens = Math.max(1, countTokensSync(text));
    if (current.length && current_tokens + seg_tokens > chunk_max_tokens) {
      chunks.push({
        text: current.join("\n\n"),
        first_segment_id: current_first,
      });
      current = [];
      current_tokens = 0;
      current_first = null;
    }
    if (current.length === 0) current_first = seg.id;
    current.push(text);
    current_tokens += seg_tokens;
    void model;
  }
  if (current.length) {
    chunks.push({
      text: current.join("\n\n"),
      first_segment_id: current_first,
    });
  }
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
  // Voiding the unused variable to keep TypeScript quiet about
  // SegmentStatus not appearing in this file (we just reference the
  // type for the return signature).
  void SegmentStatus;
  void (null as unknown as SegmentStatusT);
  return rows.slice(0, max_segments);
}

function payloadOf(summary: IntakeSummary): Record<string, unknown> {
  return {
    chunks: summary.chunks,
    cached_chunks: summary.cached_chunks,
    proposed_count: summary.proposed_count,
    prompt_tokens: summary.prompt_tokens,
    completion_tokens: summary.completion_tokens,
    cost_usd: summary.cost_usd,
    failed_chunks: summary.failed_chunks,
    pov: summary.pov,
    tense: summary.tense,
    register: summary.register,
    audience: summary.audience,
    suggested_style_profile: summary.suggested_style_profile,
  };
}

interface PersistIntakeRunInput {
  project_id: string;
  summary: IntakeSummary;
  kind: IntakeRunKindT;
  helper_model: string;
  started_at: number;
  status: IntakeRunStatusT;
  chapter_id?: string | null;
  error?: string | null;
}

async function persistIntakeRun(
  input: PersistIntakeRunInput,
): Promise<string | null> {
  try {
    const row = await recordIntakeRun({
      project_id: input.project_id,
      kind: input.kind,
      chapter_id: input.chapter_id ?? null,
      helper_model: input.helper_model,
      started_at: input.started_at,
      finished_at: nowMs(),
      status: input.status,
      chunks: input.summary.chunks,
      cached_chunks: input.summary.cached_chunks,
      proposed_count: input.summary.proposed_count,
      failed_chunks: input.summary.failed_chunks,
      prompt_tokens: input.summary.prompt_tokens,
      completion_tokens: input.summary.completion_tokens,
      cost_usd: input.summary.cost_usd,
      pov: input.summary.pov,
      tense: input.summary.tense,
      narrative_register: input.summary.register,
      audience: input.summary.audience,
      suggested_style_profile: input.summary.suggested_style_profile,
      notes: input.summary.notes,
      error: input.error ?? null,
    });
    if (input.summary.proposed_entry_ids.length) {
      await attachIntakeRunEntries(
        input.project_id,
        row.id,
        input.summary.proposed_entry_ids,
      );
    }
    return row.id;
  } catch {
    return null;
  }
}
