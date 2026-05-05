/**
 * Translation pipeline (mirrors `epublate.core.pipeline`).
 *
 * P2 ships the single-segment translator path:
 *
 *   1. Short-circuit trivially empty segments (whitespace-only,
 *      placeholder-only) — the source round-trips verbatim and no LLM
 *      call is made. Mirrors PRD F-IO-2.
 *   2. Build the translator messages with the prompt module's
 *      glossary / context blocks. Glossary stays empty until P3.
 *   3. Compute the cache key. On hit, replay the cached trace; on
 *      miss, hit the provider.
 *   4. Validate the splice round-trip — the placeholder validator
 *      from `epub/segmentation` is the last gate before the DB write.
 *   5. Persist `segment.target_text`, the audit `llm_calls` row, and
 *      a `segment.translated` event in a single Dexie transaction.
 *
 * Cascade re-translation, glossary state hash, target-only soft-locks,
 * and lore-book write-back live in P3 and beyond.
 */

import { newId } from "@/lib/id";
import { autoProposeFromTranslatorTrace } from "@/core/auto_propose";
import { cacheKeyForMessages, EMPTY_GLOSSARY_HASH } from "@/core/cache";
import { type ContextMode, isDialogueSegment } from "@/core/dialogue";
import {
  findLlmCallByCacheKey,
  insertLlmCall,
} from "@/db/repo/llm_calls";
import { getGlossaryEntry, recordMentions } from "@/db/repo/glossary";
import { openProjectDb } from "@/db/dexie";
import { SegmentStatus, type SegmentStatusT } from "@/db/schema";
import { type Segment } from "@/formats/epub/types";
import {
  isTriviallyEmpty,
  validateSegmentPlaceholders,
} from "@/formats/epub/segmentation";
import {
  buildConstraints,
  buildTargetOnlyConstraints,
  findMentions,
  findTargetDoubledParticles,
  glossaryHash as computeGlossaryHash,
  hasFlaggingViolation,
  validateTarget,
  type Violation,
} from "@/glossary/enforcer";
import type { GlossaryEntryWithAliases } from "@/glossary/models";
import {
  type ChatRequest,
  type LLMProvider,
  type ResponseFormat,
  LLMError,
} from "@/llm/base";
import { chatWithJsonFallback } from "@/llm/json_mode";
import { estimateCost } from "@/llm/pricing";
import {
  type ContextSegment,
  type GlossaryConstraint,
  type TargetOnlyConstraint,
  type TranslatorTrace,
  buildTranslatorMessages,
  parseTranslatorResponse,
} from "@/llm/prompts/translator";

export const PURPOSE_TRANSLATE = "translate";

export interface ContextOptions {
  max_segments: number;
  max_chars: number;
  /**
   * Selection strategy for the context window.
   *   - `"off"`      — never inject context (same as `max_segments: 0`).
   *   - `"previous"` — inject the previous N segments verbatim.
   *   - `"dialogue"` — only inject context when *this* segment is
   *     dialogue, and pull only previously translated dialogue
   *     segments. Cheaper for novels where dialogue is interleaved
   *     with descriptive narration.
   *
   * Defaults to `"previous"` to preserve the legacy behaviour for
   * existing projects.
   */
  mode?: ContextMode;
}

export const DEFAULT_CONTEXT_OPTIONS: ContextOptions = {
  max_segments: 0,
  max_chars: 0,
  mode: "previous",
};

export interface TranslateOptions {
  model: string;
  temperature?: number | null;
  seed?: number | null;
  /**
   * Pre-built constraint arrays. When set, the pipeline uses these
   * verbatim (and trusts the caller to pass the matching
   * `glossary_state`). When unset, the pipeline projects
   * `glossary_state` itself.
   */
  glossary?: readonly GlossaryConstraint[] | null;
  target_only_glossary?: readonly TargetOnlyConstraint[] | null;
  /**
   * Active glossary state for this segment. Drives the matcher, the
   * validator, and the cache hash. When omitted the pipeline behaves
   * as if there is no glossary.
   */
  glossary_state?: readonly GlossaryEntryWithAliases[] | null;
  bypass_cache?: boolean;
  response_format?: ResponseFormat | null;
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | null;
  context?: ContextOptions;
  signal?: AbortSignal;
}

export interface TranslateOutcome {
  segment_id: string;
  target_text: string;
  trace: TranslatorTrace;
  cache_hit: boolean;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  llm_call_id: string;
  cache_key: string;
  trivial: boolean;
  violations: Violation[];
}

export interface TranslateInput {
  project_id: string;
  source_lang: string;
  target_lang: string;
  style_guide?: string | null;
  /**
   * Optional curator-authored chapter notes. The pipeline forwards
   * them verbatim to `buildTranslatorMessages` (and folds them into
   * the cache key so two chapters with different notes never collide
   * in the cache). The batch runner pre-loads chapter notes once per
   * chapter and reuses them across segments.
   */
  chapter_notes?: string | null;
  segment: Segment;
  provider: LLMProvider;
  options: TranslateOptions;
}

/**
 * Translate one segment and persist the result.
 *
 * Throws `LLMError` (or its subclasses) when the provider fails past
 * the configured retry budget, or when the response can't be parsed
 * as a translator trace. The caller is responsible for surfacing the
 * error to the curator and (optionally) flipping the segment to
 * `flagged` — the pipeline never persists a malformed translation.
 */
export async function translateSegment(
  input: TranslateInput,
): Promise<TranslateOutcome> {
  const { project_id, source_lang, target_lang, style_guide, chapter_notes, segment, provider, options } = input;

  if (isTriviallyEmpty(segment.source_text)) {
    return shortCircuitTrivial({ project_id, segment });
  }

  const glossaryState = options.glossary_state ?? [];
  const projected: readonly GlossaryConstraint[] = options.glossary ??
    buildConstraints(glossaryState);
  const targetOnly: readonly TargetOnlyConstraint[] =
    options.target_only_glossary ?? buildTargetOnlyConstraints(glossaryState);
  const glossary_hash = glossaryState.length
    ? await computeGlossaryHash(glossaryState)
    : EMPTY_GLOSSARY_HASH;

  const context = await collectContextSegments({
    project_id,
    segment,
    options: options.context ?? null,
  });

  const messages = buildTranslatorMessages({
    source_lang,
    target_lang,
    source_text: segment.source_text,
    style_guide: style_guide ?? null,
    chapter_notes: chapter_notes ?? null,
    glossary: projected,
    target_only_glossary: targetOnly,
    context,
  });

  const baseKey = await cacheKeyForMessages({
    model: options.model,
    messages,
    glossary_hash,
  });
  const cache_key = options.bypass_cache ? `${baseKey}:retry` : baseKey;

  const request_payload = {
    model: options.model,
    messages,
    temperature: options.temperature ?? null,
    seed: options.seed ?? null,
    glossary_hash,
  };
  const request_json = stableStringify(request_payload);

  if (!options.bypass_cache) {
    const hit = await findLlmCallByCacheKey(project_id, cache_key);
    if (hit?.response_json) {
      return replayFromCache({
        project_id,
        segment,
        hit_response_json: hit.response_json,
        hit_model: hit.model,
        hit_prompt_tokens: hit.prompt_tokens ?? 0,
        hit_completion_tokens: hit.completion_tokens ?? 0,
        request_json,
        cache_key,
        glossary_state: glossaryState,
        source_lang,
        target_lang,
      });
    }
  }

  const chat: ChatRequest = {
    messages,
    model: options.model,
    response_format: options.response_format ?? undefined,
    temperature: options.temperature ?? undefined,
    seed: options.seed ?? undefined,
    reasoning_effort: options.reasoning_effort ?? undefined,
    signal: options.signal,
  };
  const result = await chatWithJsonFallback(provider, chat);

  let trace: TranslatorTrace;
  try {
    trace = parseTranslatorResponse(result.content);
  } catch (err) {
    // Keep the audit trail even on parse failure.
    await persistFailedCall({
      project_id,
      segment_id: segment.id,
      model: result.model,
      prompt_tokens: result.usage?.prompt_tokens ?? 0,
      completion_tokens: result.usage?.completion_tokens ?? 0,
      request_json,
      response_json: stableStringify({ content: result.content, raw: result.raw }),
      cache_key,
    });
    throw err;
  }

  const spliced: Segment = {
    ...segment,
    target_text: trace.target,
  };
  validateSegmentPlaceholders(spliced);

  const violations = collectViolations({
    source_text: segment.source_text,
    target_text: trace.target,
    glossary_state: glossaryState,
    target_lang,
  });
  const final_status: SegmentStatusT = hasFlaggingViolation(violations)
    ? SegmentStatus.FLAGGED
    : SegmentStatus.TRANSLATED;

  const prompt_tokens = result.usage?.prompt_tokens ?? 0;
  const completion_tokens = result.usage?.completion_tokens ?? 0;
  const cost_usd = estimateCost(result.model, prompt_tokens, completion_tokens);

  const llm_call_id = newId();
  const response_json = stableStringify({
    content: result.content,
    trace,
    raw: result.raw,
    violations,
  });
  const created_at = Date.now();

  const db = openProjectDb(project_id);
  await db.transaction(
    "rw",
    db.segments,
    db.llm_calls,
    db.events,
    async () => {
      await db.segments.update(segment.id, {
        target_text: trace.target,
        status: final_status,
      });
      await db.llm_calls.put({
        id: llm_call_id,
        project_id,
        segment_id: segment.id,
        purpose: PURPOSE_TRANSLATE,
        model: result.model,
        prompt_tokens,
        completion_tokens,
        cost_usd,
        cache_hit: 0,
        cache_key,
        request_json,
        response_json,
        created_at,
      });
      await db.events.add({
        project_id,
        ts: created_at,
        kind: "segment.translated",
        payload_json: stableStringify({
          segment_id: segment.id,
          model: result.model,
          prompt_tokens,
          completion_tokens,
          cost_usd,
          cache_hit: false,
          llm_call_id,
          violations: violations.length,
        }),
      });
      if (violations.length) {
        await db.events.add({
          project_id,
          ts: created_at,
          kind: "segment.flagged",
          payload_json: stableStringify({
            segment_id: segment.id,
            violations,
          }),
        });
      }
    },
  );

  // Promote `trace.new_entities` into proposed glossary entries first,
  // so the matcher below can see them. Runs outside the segment
  // transaction so a glossary write hiccup never rolls back the
  // translation we just stored.
  const propose_outcome = await autoProposeFromTranslatorTrace({
    project_id,
    segment_id: segment.id,
    trace,
    source_lang,
    target_lang,
  });

  // Mention rows live outside the segment transaction because they
  // touch a different store; record() runs its own transaction and is
  // safe to retry on failure.
  //
  // We compute mentions over the *union* of the pre-call glossary
  // state and any freshly-created entries from `autoProposeFromTranslatorTrace`.
  // Without this, the segment that *introduced* a new term never
  // shows up in the new entry's "occurrences" list, which curators
  // (rightly) read as a bug — the first appearance of a term is the
  // most informative one for figuring out what it should mean.
  const matcher_state = await augmentWithFreshEntries(
    project_id,
    glossaryState,
    propose_outcome.created_entry_ids,
  );
  if (matcher_state.length) {
    const mentions = findMentions(segment.source_text, matcher_state);
    await recordMentions(project_id, segment.id, mentions);
  }

  return {
    segment_id: segment.id,
    target_text: trace.target,
    trace,
    cache_hit: false,
    prompt_tokens,
    completion_tokens,
    cost_usd,
    llm_call_id,
    cache_key,
    trivial: false,
    violations,
  };
}

interface ReplayInput {
  project_id: string;
  segment: Segment;
  hit_response_json: string;
  hit_model: string;
  hit_prompt_tokens: number;
  hit_completion_tokens: number;
  request_json: string;
  cache_key: string;
  glossary_state: readonly GlossaryEntryWithAliases[];
  source_lang: string;
  target_lang: string;
}

async function replayFromCache(input: ReplayInput): Promise<TranslateOutcome> {
  const {
    project_id,
    segment,
    hit_response_json,
    hit_model,
    hit_prompt_tokens,
    hit_completion_tokens,
    request_json,
    cache_key,
    glossary_state,
    source_lang,
    target_lang,
  } = input;
  const payload = JSON.parse(hit_response_json) as {
    trace?: TranslatorTrace;
    content?: string;
  };
  let trace: TranslatorTrace;
  if (payload.trace && typeof payload.trace.target === "string") {
    trace = {
      target: payload.trace.target,
      used_entries: payload.trace.used_entries ?? [],
      new_entities: payload.trace.new_entities ?? [],
      notes: payload.trace.notes ?? null,
    };
  } else if (typeof payload.content === "string") {
    trace = parseTranslatorResponse(payload.content);
  } else {
    throw new LLMError("cached llm_call has no usable response payload");
  }

  const spliced: Segment = { ...segment, target_text: trace.target };
  validateSegmentPlaceholders(spliced);

  const violations = collectViolations({
    source_text: segment.source_text,
    target_text: trace.target,
    glossary_state,
    target_lang,
  });
  const final_status: SegmentStatusT = hasFlaggingViolation(violations)
    ? SegmentStatus.FLAGGED
    : SegmentStatus.TRANSLATED;

  const llm_call_id = newId();
  const created_at = Date.now();
  const response_json = hit_response_json;

  const db = openProjectDb(project_id);
  await db.transaction(
    "rw",
    db.segments,
    db.llm_calls,
    db.events,
    async () => {
      await db.segments.update(segment.id, {
        target_text: trace.target,
        status: final_status,
      });
      await db.llm_calls.put({
        id: llm_call_id,
        project_id,
        segment_id: segment.id,
        purpose: PURPOSE_TRANSLATE,
        model: hit_model,
        prompt_tokens: hit_prompt_tokens,
        completion_tokens: hit_completion_tokens,
        cost_usd: 0,
        cache_hit: 1,
        cache_key,
        request_json,
        response_json,
        created_at,
      });
      await db.events.add({
        project_id,
        ts: created_at,
        kind: "segment.translated",
        payload_json: stableStringify({
          segment_id: segment.id,
          model: hit_model,
          cache_hit: true,
          llm_call_id,
          violations: violations.length,
        }),
      });
      if (violations.length) {
        await db.events.add({
          project_id,
          ts: created_at,
          kind: "segment.flagged",
          payload_json: stableStringify({
            segment_id: segment.id,
            violations,
          }),
        });
      }
    },
  );

  // Replay traces still carry `new_entities`; promote them so a
  // cache-hit run grows the glossary just like a fresh translation.
  const propose_outcome = await autoProposeFromTranslatorTrace({
    project_id,
    segment_id: segment.id,
    trace,
    source_lang,
    target_lang,
  });

  // Match against pre-call state ∪ freshly-created entries so the
  // introducing segment lands in the new entry's occurrences. See the
  // sibling comment in `translateSegment` for the rationale.
  const matcher_state = await augmentWithFreshEntries(
    project_id,
    glossary_state,
    propose_outcome.created_entry_ids,
  );
  if (matcher_state.length) {
    const mentions = findMentions(segment.source_text, matcher_state);
    await recordMentions(project_id, segment.id, mentions);
  }

  return {
    segment_id: segment.id,
    target_text: trace.target,
    trace,
    cache_hit: true,
    prompt_tokens: hit_prompt_tokens,
    completion_tokens: hit_completion_tokens,
    cost_usd: 0,
    llm_call_id,
    cache_key,
    trivial: false,
    violations,
  };
}

interface TrivialInput {
  project_id: string;
  segment: Segment;
}

async function shortCircuitTrivial(
  input: TrivialInput,
): Promise<TranslateOutcome> {
  const { project_id, segment } = input;
  const target = segment.source_text;
  const spliced: Segment = { ...segment, target_text: target };
  validateSegmentPlaceholders(spliced);

  const created_at = Date.now();
  const db = openProjectDb(project_id);
  await db.transaction("rw", db.segments, db.events, async () => {
    await db.segments.update(segment.id, {
      target_text: target,
      status: SegmentStatus.TRANSLATED,
    });
    await db.events.add({
      project_id,
      ts: created_at,
      kind: "segment.translated_trivial",
      payload_json: stableStringify({
        segment_id: segment.id,
        char_count: target.length,
        reason: "trivially_empty",
      }),
    });
  });

  return {
    segment_id: segment.id,
    target_text: target,
    trace: { target, used_entries: [], new_entities: [], notes: null },
    cache_hit: false,
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    llm_call_id: "",
    cache_key: "",
    trivial: true,
    violations: [],
  };
}

interface CollectContextInput {
  project_id: string;
  segment: Segment;
  options: ContextOptions | null;
}

/**
 * Pull a small window of preceding chapter segments to feed the
 * translator as `Context` rows. Falls back to the project row's
 * `context_max_segments` / `context_max_chars` when the caller didn't
 * pass an explicit options object — that's how the dashboard's
 * "context segments" setting reaches the prompt.
 *
 * Skips trivially-empty source segments so we don't waste tokens on
 * whitespace, and stops as soon as the cumulative source/target text
 * crosses `max_chars` (when set). Cache keys still flip when the
 * window changes, which is the desired behaviour: editing previous
 * segments invalidates downstream cache hits in reading order, just
 * like the Python tool.
 */
async function collectContextSegments(
  input: CollectContextInput,
): Promise<ContextSegment[]> {
  const { project_id, segment } = input;
  const opts = await resolveContextOptions(project_id, input.options);
  const mode: ContextMode = opts.mode ?? "previous";
  if (mode === "off") return [];
  if (opts.max_segments <= 0) return [];

  // Dialogue-aware mode: only fetch context when *this* segment looks
  // like dialogue. Narration / descriptive prose translates without
  // any context block, which is the cheap path users wanted for
  // novels that mix narration and exchanges.
  if (mode === "dialogue" && !isDialogueSegment(segment.source_text)) {
    return [];
  }

  const db = openProjectDb(project_id);
  const upper = Math.max(0, segment.idx);
  if (upper === 0) return [];

  // We over-fetch a bit (×4) when a chapter has trivial-empty
  // segments interspersed; the loop below re-counts post-filter.
  // Dialogue mode pulls a wider window because we expect many
  // non-dialogue lines between two character exchanges.
  const fetch_multiplier = mode === "dialogue" ? 16 : 4;
  const lower = Math.max(
    0,
    upper - Math.max(opts.max_segments, 0) * fetch_multiplier,
  );
  const rows = await db.segments
    .where("[chapter_id+idx]")
    .between([segment.chapter_id, lower], [segment.chapter_id, upper], true, false)
    .toArray();

  const ordered = rows.sort((a, b) => b.idx - a.idx);
  const context: ContextSegment[] = [];
  let chars = 0;
  for (const row of ordered) {
    if (context.length >= opts.max_segments) break;
    const src = (row.source_text ?? "").trim();
    if (!src) continue;
    if (mode === "dialogue") {
      // Skip non-dialogue segments entirely. We *also* require a
      // target_text — we want to feed the model previously *translated*
      // dialogue, not the source-only block (otherwise we'd be paying
      // tokens on raw source we'd already pay for via the live segment
      // anyway).
      if (!isDialogueSegment(row.source_text)) continue;
      if (!(row.target_text ?? "").trim()) continue;
    }
    const tgt = (row.target_text ?? "").trim() || null;
    const piece = src.length + (tgt?.length ?? 0);
    if (
      opts.max_chars > 0 &&
      context.length > 0 &&
      chars + piece > opts.max_chars
    ) {
      break;
    }
    context.push({
      source_text: row.source_text,
      target_text: row.target_text,
      segments_back: segment.idx - row.idx,
    });
    chars += piece;
  }
  return context;
}

async function resolveContextOptions(
  project_id: string,
  override: ContextOptions | null,
): Promise<ContextOptions> {
  if (override) return override;
  const db = openProjectDb(project_id);
  const row = await db.projects.get(project_id);
  if (!row) return DEFAULT_CONTEXT_OPTIONS;
  return {
    max_segments: row.context_max_segments ?? 0,
    max_chars: row.context_max_chars ?? 0,
    mode: row.context_mode ?? "previous",
  };
}

interface CollectViolationsInput {
  source_text: string;
  target_text: string;
  glossary_state: readonly GlossaryEntryWithAliases[];
  target_lang: string;
}

function collectViolations(input: CollectViolationsInput): Violation[] {
  const out: Violation[] = [];
  if (input.glossary_state.length) {
    out.push(
      ...validateTarget({
        source_text: input.source_text,
        target_text: input.target_text,
        entries: input.glossary_state,
      }),
    );
  }
  out.push(
    ...findTargetDoubledParticles(input.target_text, {
      target_lang: input.target_lang,
    }),
  );
  return out;
}

interface FailedCallInput {
  project_id: string;
  segment_id: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  request_json: string;
  response_json: string;
  cache_key: string;
}

async function persistFailedCall(input: FailedCallInput): Promise<void> {
  await insertLlmCall(input.project_id, {
    id: newId(),
    project_id: input.project_id,
    segment_id: input.segment_id,
    purpose: `${PURPOSE_TRANSLATE}.failed`,
    model: input.model,
    prompt_tokens: input.prompt_tokens,
    completion_tokens: input.completion_tokens,
    cost_usd: 0,
    cache_hit: false,
    cache_key: input.cache_key,
    request_json: input.request_json,
    response_json: input.response_json,
  });
}

/**
 * Append freshly-proposed glossary entries to the matcher state.
 *
 * Used by both `translateSegment` and `replayFromCache` to ensure the
 * segment that introduced a new entity gets logged in `entity_mentions`
 * for that entity. Without this, the LLM proposes "Chen Lao", we
 * persist him as a `proposed` glossary row, but the segment that
 * mentioned him for the first time never lands in his "occurrences"
 * list — which surprised curators (rightly).
 *
 * Best-effort: if loading any of the new ids fails (the row was
 * deleted between propose and load — unlikely but possible on a
 * heavily concurrent UI), we skip it rather than blowing up the
 * pipeline. The pre-call glossary state is always returned as-is.
 */
async function augmentWithFreshEntries(
  project_id: string,
  pre_call_state: readonly GlossaryEntryWithAliases[],
  fresh_entry_ids: readonly string[],
): Promise<GlossaryEntryWithAliases[]> {
  if (!fresh_entry_ids.length) return [...pre_call_state];
  const seen = new Set(pre_call_state.map((e) => e.entry.id));
  const out: GlossaryEntryWithAliases[] = [...pre_call_state];
  for (const id of fresh_entry_ids) {
    if (seen.has(id)) continue;
    try {
      const ent = await getGlossaryEntry(project_id, id);
      if (ent) {
        out.push(ent);
        seen.add(id);
      }
    } catch {
      // Best-effort augmentation; we'd rather record N-1 mentions
      // than zero.
    }
  }
  return out;
}

/** Stable JSON stringify so cache keys / audit rows are deterministic. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, sortedReplacer);
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = obj[k];
    }
    return out;
  }
  return value;
}
