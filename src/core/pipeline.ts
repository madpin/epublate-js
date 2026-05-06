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
import { type EmbeddingPrefetcher } from "@/core/embedding_prefetch";
import {
  findLlmCallByCacheKey,
  insertLlmCall,
} from "@/db/repo/llm_calls";
import {
  bulkUpsertEmbeddings,
  getEmbedding,
} from "@/db/repo/embeddings";
import { getGlossaryEntry, recordMentions } from "@/db/repo/glossary";
import { openProjectDb } from "@/db/dexie";
import { SegmentStatus, type SegmentStatusT } from "@/db/schema";
import {
  PURPOSE_EMBEDDING,
  type EmbeddingProvider,
  EmbeddingError,
  unpackFloat32,
} from "@/llm/embeddings/base";
import { resolveProjectGlossaryWithLore } from "@/lore/attach";
import { type Segment } from "@/formats/epub/types";
import {
  isTriviallyEmpty,
  validateSegmentPlaceholders,
} from "@/formats/epub/segmentation";
import {
  buildConstraints,
  buildProposedHints,
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
   *   - `"relevant"` — embed the segment and pick the top-K
   *     translated/approved segments by cosine similarity, regardless
   *     of chapter. Falls back to `"previous"` when no embedding
   *     provider is configured. Phase 3.
   *
   * Defaults to `"previous"` to preserve the legacy behaviour for
   * existing projects.
   */
  mode?: ContextMode;
  /**
   * Minimum cosine similarity threshold for `mode = "relevant"`. The
   * pipeline drops candidates below this score from the picker so the
   * prompt never gets stuffed with weakly related neighbours. Defaults
   * to `0.65` when omitted; ignored for other modes. Phase 3.
   */
  min_similarity?: number;
}

export const DEFAULT_CONTEXT_OPTIONS: ContextOptions = {
  max_segments: 0,
  max_chars: 0,
  mode: "previous",
};

/** Default min-similarity floor for `mode = "relevant"`. Phase 3. */
export const DEFAULT_RELEVANT_MIN_SIMILARITY = 0.65;

/**
 * Per-segment Lore-Book retrieval hook.
 *
 * When set, the pipeline embeds the segment's source text once with
 * the configured provider, persists the vector in `embeddings`, and
 * passes it to `resolveProjectGlossaryWithLore` so each attached Lore
 * Book is filtered down to its top-K closest entries. The caller
 * supplies the project-side glossary state via `glossary_state`; the
 * pipeline performs the merge itself.
 *
 * If the embedding call fails (provider rate-limited, model
 * unavailable, …) the pipeline falls back to the legacy
 * "flatten everything" behaviour — embedding failures must never
 * block a translation.
 */
export interface LoreRetrievalOptions {
  provider: EmbeddingProvider;
  /**
   * Override the per-attachment defaults; matches the resolver's
   * `LoreRetrievalContext.default_*` knobs.
   */
  default_top_k?: number;
  default_min_similarity?: number;
}

/**
 * Phase 4: per-call knobs for proposed-entry hints.
 *
 * The pipeline always *attempts* the retrieval when an embedding
 * vector is available; these options just control K and the
 * similarity floor. Set `top_k = 0` to bypass the section entirely
 * for a particular call (useful for test-mode runs where you want a
 * fully-deterministic prompt).
 */
export interface ProposedHintsRetrievalOptions {
  /** Default 8. Max number of proposed entries surfaced in the prompt. */
  top_k?: number;
  /**
   * Default 0.72. Floor below which a candidate is dropped — keeps
   * the section tight so the LLM doesn't drown in weakly-related
   * suggestions.
   */
  min_similarity?: number;
}

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
   *
   * When `lore_retrieval` is set, this should contain the
   * **project-side** entries only — the pipeline merges in attached
   * Lore-Book entries itself. When `lore_retrieval` is unset, the
   * caller is expected to have pre-merged any Lore-Book state.
   */
  glossary_state?: readonly GlossaryEntryWithAliases[] | null;
  /** Optional embedding-based Lore-Book retrieval (Phase 2). */
  lore_retrieval?: LoreRetrievalOptions | null;
  /**
   * Optional embedding provider used for `context.mode = "relevant"`
   * (Phase 3) when `lore_retrieval` is not set. The pipeline embeds
   * the source text once with this provider, persists the vector,
   * and reuses it for cosine top-K context picking. When `null` the
   * pipeline falls back to `previous` mode for any `relevant` request.
   */
  embedding_provider?: EmbeddingProvider | null;
  /**
   * Optional shared {@link EmbeddingPrefetcher}. When set, the
   * pipeline routes its single per-segment vector lookup through the
   * prefetcher so it can join a bulk batch already in flight. Created
   * by the batch runner once per run; ignored when not provided. This
   * is the path that turns "5 000 single-segment embed calls" into
   * "≈ 78 batched calls running in parallel with translator workers".
   */
  embedding_prefetcher?: EmbeddingPrefetcher | null;
  /** Phase 4: proposed-entry hint retrieval. */
  proposed_hints?: ProposedHintsRetrievalOptions | null;
  bypass_cache?: boolean;
  response_format?: ResponseFormat | null;
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | "none" | null;
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

  // Phase 2 + 3: best-effort segment-source embedding. The vector is
  // reused for two things in this call: (a) Lore-Book top-K
  // retrieval before constraint building, and (b) `relevant` context
  // mode in `collectContextSegments`. We compute it once and keep it
  // around in `segment_vec_cache` so we don't double-charge.
  //
  // Embedding is opportunistic: whenever an embedding provider is
  // available we embed + persist the segment, regardless of the
  // active context mode. This lets `relevant` mode kick in mid-book
  // without the curator running an explicit backfill pass — every
  // segment translated since the provider was configured already
  // contributes to the candidate pool. The cached vector is reused
  // for downstream Lore-Book retrieval and `relevant` context picks
  // so each segment costs at most one `embed()` round-trip.
  const project_glossary = options.glossary_state ?? [];
  let glossaryState: readonly GlossaryEntryWithAliases[] = project_glossary;
  let segment_vec_cache: Float32Array | null = null;
  let embedding_model_used: string | null = null;
  // `lore_retrieval.provider` and `embedding_provider` should
  // normally be the same instance (the batch runner passes both),
  // but we treat them as independent capabilities so a caller can
  // opt into one without the other.
  const active_emb_provider =
    options.lore_retrieval?.provider ?? options.embedding_provider ?? null;
  if (active_emb_provider) {
    if (options.embedding_prefetcher) {
      // Hot path: piggyback on a bulk batch the prefetcher
      // dispatched alongside the translator pool. Hits the in-
      // memory promise map first, the IDB cache second, and only
      // falls back to a single-segment embed if the worker raced
      // ahead of the prefetcher entirely.
      segment_vec_cache =
        await options.embedding_prefetcher.getEmbedding(segment);
    } else {
      // Test / single-shot path: keep the legacy per-segment embed
      // so unit tests don't have to construct a prefetcher.
      const result = await embedAndPersistSegment({
        project_id,
        segment,
        provider: active_emb_provider,
        signal: options.signal,
      });
      segment_vec_cache = result.segment_vec;
    }
    embedding_model_used = active_emb_provider.model;
  }
  if (options.lore_retrieval && segment_vec_cache) {
    glossaryState = await resolveProjectGlossaryWithLore(
      project_id,
      project_glossary,
      {
        segment_vec: segment_vec_cache,
        embedding_model: options.lore_retrieval.provider.model,
        default_top_k: options.lore_retrieval.default_top_k,
        default_min_similarity: options.lore_retrieval.default_min_similarity,
      },
    );
  } else if (options.lore_retrieval) {
    // Embedding failed but Lore Books are attached → fall back to
    // the legacy flat merge so the prompt still sees them.
    glossaryState = await resolveProjectGlossaryWithLore(
      project_id,
      project_glossary,
      null,
    );
  }

  const projected: readonly GlossaryConstraint[] = options.glossary ??
    buildConstraints(glossaryState);
  const targetOnly: readonly TargetOnlyConstraint[] =
    options.target_only_glossary ?? buildTargetOnlyConstraints(glossaryState);
  const glossary_hash = glossaryState.length
    ? await computeGlossaryHash(glossaryState)
    : EMPTY_GLOSSARY_HASH;

  // Phase 4: surface relevant *proposed* glossary entries as soft
  // hints. Skipped entirely when no embedding vector is available
  // (no provider configured, or embed() failed) so existing
  // configurations behave exactly as before.
  let proposed_hints_block = "";
  let proposed_hints_used: readonly string[] = [];
  if (segment_vec_cache && embedding_model_used) {
    const hints = await retrieveProposedHints({
      project_id,
      segment_vec: segment_vec_cache,
      embedding_model: embedding_model_used,
      project_glossary,
      options: options.proposed_hints ?? null,
    });
    proposed_hints_block = hints.block;
    proposed_hints_used = hints.used_ids;
  }

  const context = await collectContextSegments({
    project_id,
    segment,
    options: options.context ?? null,
    embedding_context:
      segment_vec_cache && embedding_model_used
        ? {
            segment_vec: segment_vec_cache,
            embedding_model: embedding_model_used,
          }
        : null,
  });

  const messages = buildTranslatorMessages({
    source_lang,
    target_lang,
    source_text: segment.source_text,
    style_guide: style_guide ?? null,
    chapter_notes: chapter_notes ?? null,
    glossary: projected,
    target_only_glossary: targetOnly,
    proposed_hints_block,
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
    proposed_hints_used: proposed_hints_used.length
      ? [...proposed_hints_used].sort()
      : undefined,
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
      response_json: stableStringify({
        content: result.content,
        raw: result.raw,
        duration_ms: result.duration_ms ?? null,
      }),
      cache_key,
      duration_ms: result.duration_ms ?? null,
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
    duration_ms: result.duration_ms ?? null,
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
        duration_ms: result.duration_ms ?? null,
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
        // null (not 0) so the LLM Activity screen renders "cache
        // replay" instead of suggesting the call took 0 ms.
        duration_ms: null,
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
  /**
   * Phase 3: when set, the `"relevant"` mode is allowed to query
   * `segment_embeddings` for cosine top-K matches. When unset
   * (no embedding provider configured), `"relevant"` mode silently
   * falls back to `"previous"`.
   */
  embedding_context?: {
    segment_vec: Float32Array;
    embedding_model: string;
  } | null;
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
  const { project_id, segment, embedding_context } = input;
  const opts = await resolveContextOptions(project_id, input.options);
  let mode: ContextMode = opts.mode ?? "previous";
  if (mode === "off") return [];
  if (opts.max_segments <= 0) return [];

  // Phase 3: `relevant` mode delegates to the embedding-based picker
  // when a segment vector is available. When embeddings are off (no
  // provider configured, or the embedding step failed earlier in the
  // pipeline) we silently fall back to `"previous"` so the prompt is
  // never empty just because the user picked the wrong mode.
  if (mode === "relevant") {
    if (embedding_context) {
      return collectRelevantContextSegments({
        project_id,
        segment,
        opts,
        segment_vec: embedding_context.segment_vec,
        embedding_model: embedding_context.embedding_model,
      });
    }
    mode = "previous";
  }

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

interface CollectRelevantInput {
  project_id: string;
  segment: Segment;
  opts: ContextOptions;
  segment_vec: Float32Array;
  embedding_model: string;
}

/**
 * Phase 3: cosine top-K context picker.
 *
 * Selects translated / approved segments earlier in spine order and
 * ranks them by similarity against the current segment's vector. The
 * shape of the returned `ContextSegment[]` matches the legacy
 * `previous` mode so the prompt block doesn't change.
 *
 * Eligibility filter (mirrors the plan):
 * - `status ∈ {translated, approved}` — the LLM should never see a
 *   pending source-only neighbour as authoritative.
 * - Earlier in spine than the current segment. We compare on
 *   `(spine_idx, idx)` so segments from earlier chapters always
 *   outrank later ones at the same idx.
 * - Has a non-empty target text (otherwise there's nothing useful to
 *   show the LLM).
 *
 * The top-K cap is `opts.max_segments`. `min_similarity` defaults to
 * 0.65 — slightly lower than Lore-Book retrieval because we want at
 * least *some* context across the book, not "perfect matches only".
 */
async function collectRelevantContextSegments(
  input: CollectRelevantInput,
): Promise<ContextSegment[]> {
  const { project_id, segment, opts, segment_vec, embedding_model } = input;
  const { cosineTopK } = await import("@/db/repo/embeddings");
  const db = openProjectDb(project_id);
  // Resolve the current chapter's spine index so we can scope the
  // candidate set to "earlier in book" without joining manually.
  const cur_chapter = await db.chapters.get(segment.chapter_id);
  if (!cur_chapter) return [];
  const cur_spine = cur_chapter.spine_idx;

  // Pull every translated/approved segment in the project. This is a
  // simpler filter than over-fetching from `[chapter_id+idx]` because
  // `relevant` deliberately ignores chapter boundaries.
  const candidates = await db.segments
    .where("status")
    .anyOf([SegmentStatus.TRANSLATED, SegmentStatus.APPROVED])
    .filter((row) => row.id !== segment.id && !!row.target_text?.trim())
    .toArray();

  // Spine ordering: drop any segment that lives at the same chapter +
  // idx (or later) than the current one, so the LLM doesn't get a
  // "future" neighbour. We resolve chapter spine indexes lazily and
  // memoise them.
  const spine_cache = new Map<string, number>();
  spine_cache.set(segment.chapter_id, cur_spine);
  const earlier: typeof candidates = [];
  for (const row of candidates) {
    let row_spine = spine_cache.get(row.chapter_id);
    if (row_spine === undefined) {
      const ch = await db.chapters.get(row.chapter_id);
      if (!ch) continue;
      row_spine = ch.spine_idx;
      spine_cache.set(row.chapter_id, row_spine);
    }
    if (row_spine > cur_spine) continue;
    if (row_spine === cur_spine && row.idx >= segment.idx) continue;
    earlier.push(row);
  }
  if (earlier.length === 0) return [];

  // Linear-scan top-K via the shared helper. We pass the candidate
  // ref-id allow-list so cosine ranking only touches eligible rows.
  const allow = new Set(earlier.map((r) => r.id));
  const min_sim =
    typeof opts.min_similarity === "number" &&
    Number.isFinite(opts.min_similarity)
      ? opts.min_similarity
      : DEFAULT_RELEVANT_MIN_SIMILARITY;
  const hits = await cosineTopK(
    "project",
    project_id,
    "segment",
    embedding_model,
    segment_vec,
    {
      k: Math.max(1, opts.max_segments),
      min_similarity: min_sim,
      filter: allow,
      exclude_ref_id: segment.id,
    },
  );
  if (hits.length === 0) return [];

  const by_id = new Map(earlier.map((r) => [r.id, r] as const));
  const context: ContextSegment[] = [];
  let chars = 0;
  for (const hit of hits) {
    const row = by_id.get(hit.ref_id);
    if (!row) continue;
    const piece = row.source_text.length + (row.target_text?.length ?? 0);
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
      // `segments_back` doesn't have a natural meaning for cross-
      // chapter retrieval; we surface the chapter offset instead so
      // the prompt's "x segments back" doesn't lie.
      segments_back: 0,
    });
    chars += piece;
  }
  return context;
}

interface RetrieveProposedHintsInput {
  project_id: string;
  segment_vec: Float32Array;
  embedding_model: string;
  project_glossary: readonly GlossaryEntryWithAliases[];
  options: ProposedHintsRetrievalOptions | null;
}

/**
 * Phase 4: retrieve top-K proposed entries by cosine similarity to
 * the segment vector, then format the "Proposed terms (unvetted
 * hints)" prompt block via `buildProposedHints`.
 *
 * Returns an empty block whenever:
 * - no proposed entries exist in the project,
 * - the embedding store has no vectors yet (provider just
 *   configured, embeddings haven't backfilled), or
 * - all candidates score below `min_similarity`.
 *
 * Best-effort: any unexpected DB / cosine failure collapses to an
 * empty block so the translator still sees the locked / confirmed
 * constraints exactly as before.
 */
async function retrieveProposedHints(
  input: RetrieveProposedHintsInput,
): Promise<{ block: string; used_ids: readonly string[] }> {
  const proposed = input.project_glossary.filter(
    (e) => e.entry.status === "proposed" && e.entry.source_term,
  );
  if (proposed.length === 0) return { block: "", used_ids: [] };
  const top_k = input.options?.top_k ?? DEFAULT_HINT_TOP_K;
  if (top_k <= 0) return { block: "", used_ids: [] };
  const min_similarity =
    input.options?.min_similarity ?? DEFAULT_HINT_MIN_SIMILARITY;
  try {
    const { cosineTopK: cosineTopKFn } = await import("@/db/repo/embeddings");
    const allow = new Set(proposed.map((e) => e.entry.id));
    // Slightly over-fetch so the deterministic tie-breaker in
    // `buildProposedHints` has room to shuffle without dropping a
    // qualified candidate.
    const hits = await cosineTopKFn(
      "project",
      input.project_id,
      "glossary_entry",
      input.embedding_model,
      input.segment_vec,
      {
        k: top_k,
        min_similarity,
        filter: allow,
      },
    );
    if (hits.length === 0) return { block: "", used_ids: [] };
    const sims = new Map<string, number>();
    for (const hit of hits) sims.set(hit.ref_id, hit.similarity);
    const built = buildProposedHints({
      entries: proposed,
      similarities: sims,
      top_k,
      min_similarity,
    });
    return { block: built.block, used_ids: built.used_ids };
  } catch {
    return { block: "", used_ids: [] };
  }
}

/** Phase 4 default top-K — kept here so the helper above stays self-contained. */
const DEFAULT_HINT_TOP_K = 8;
const DEFAULT_HINT_MIN_SIMILARITY = 0.72;

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
    min_similarity:
      row.context_relevant_min_similarity != null &&
      Number.isFinite(row.context_relevant_min_similarity)
        ? row.context_relevant_min_similarity
        : DEFAULT_RELEVANT_MIN_SIMILARITY,
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
  duration_ms?: number | null;
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
    duration_ms: input.duration_ms ?? null,
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

interface EmbedAndPersistSegmentInput {
  project_id: string;
  segment: Segment;
  provider: EmbeddingProvider;
  signal?: AbortSignal;
}

interface EmbedAndPersistSegmentResult {
  segment_vec: Float32Array | null;
}

/**
 * Best-effort segment embedding + persist.
 *
 * Used by both `lore_retrieval` (Phase 2) and pure `relevant` context
 * mode (Phase 3). Returns `null` on any failure so the caller can
 * gracefully fall back to legacy behaviour. The vector is cached in
 * `embeddings` so subsequent calls (e.g. re-translations) skip the
 * round-trip.
 */
async function embedAndPersistSegment(
  input: EmbedAndPersistSegmentInput,
): Promise<EmbedAndPersistSegmentResult> {
  const { project_id, segment, provider, signal } = input;
  try {
    const cached = await getEmbedding(
      "project",
      project_id,
      "segment",
      segment.id,
      provider.model,
    );
    if (cached) {
      return { segment_vec: unpackFloat32(cached.vector) };
    }
    const result = await provider.embed([segment.source_text], signal);
    const v = result.vectors[0];
    if (!v) return { segment_vec: null };
    const prompt_tokens = result.usage?.prompt_tokens ?? 0;
    await persistSegmentEmbedding({
      project_id,
      segment_id: segment.id,
      model: provider.model,
      provider_name: provider.name,
      vector: v,
      prompt_tokens,
      cost_usd: estimateCost(provider.model, prompt_tokens, 0),
      duration_ms: result.duration_ms ?? null,
      reported_model: result.model,
      raw: result.raw,
      usage: result.usage,
    });
    return { segment_vec: v };
  } catch (err) {
    if (err instanceof EmbeddingError) {
      try {
        const db = openProjectDb(project_id);
        await db.events.add({
          project_id,
          ts: Date.now(),
          kind: "embedding.failed",
          payload_json: stableStringify({
            segment_id: segment.id,
            scope: "segment",
            model: provider.model,
            error: err.message,
          }),
        });
      } catch {
        // event log is best-effort
      }
    }
    return { segment_vec: null };
  }
}

interface PersistSegmentEmbeddingInput {
  project_id: string;
  segment_id: string;
  model: string;
  provider_name: string;
  vector: Float32Array;
  prompt_tokens: number;
  cost_usd: number;
  duration_ms: number | null;
  reported_model: string;
  raw: unknown;
  usage: { prompt_tokens: number } | null;
}

async function persistSegmentEmbedding(
  input: PersistSegmentEmbeddingInput,
): Promise<void> {
  try {
    await bulkUpsertEmbeddings("project", input.project_id, [
      {
        scope: "segment",
        ref_id: input.segment_id,
        model: input.model,
        vector: input.vector,
      },
    ]);
    await insertLlmCall(input.project_id, {
      id: newId(),
      project_id: input.project_id,
      segment_id: input.segment_id,
      purpose: PURPOSE_EMBEDDING,
      model: input.model,
      prompt_tokens: input.prompt_tokens,
      completion_tokens: 0,
      cost_usd: input.cost_usd,
      cache_hit: false,
      cache_key: null,
      request_json: stableStringify({
        provider: input.provider_name,
        model: input.model,
        scope: "segment",
        kind: "singleton",
        segment_id: input.segment_id,
      }),
      response_json: stableStringify({
        vectors: 1,
        dim: input.vector.length,
        model: input.reported_model,
        usage: input.usage,
        duration_ms: input.duration_ms,
        raw: input.raw,
      }),
      created_at: Date.now(),
      duration_ms: input.duration_ms,
    });
  } catch {
    // Persistence failures here are non-fatal; the next translateSegment
    // call will simply re-embed.
  }
}

