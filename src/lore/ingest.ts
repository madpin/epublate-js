/**
 * Ingest a source-language ePub into a Lore Book (PRD F-LB-10).
 *
 * Mirrors `epublate.lore.ingest`. The flow is:
 *
 *   1. Load the ePub with `EpubAdapter`.
 *   2. Walk the chapters (capped by `max_chapters`) and harvest the
 *      plain-text content (placeholders stripped — we only want prose).
 *   3. Group prose into chunks under `chunk_max_chars`.
 *   4. For each chunk, call the helper LLM with the *source-language*
 *      extractor prompt and upsert each entity as a `proposed`
 *      glossary row keyed by source term + type.
 *   5. Record one `lore_source` row with the rolled-up entries-added
 *      count and emit a `lore.source_ingested` event.
 *
 * Like the project intake, results are persisted incrementally so a
 * mid-run failure leaves a partial trail that the next run can pick
 * up. The cache key folds the Lore Book's current glossary hash so a
 * curator promoting an entry invalidates stale extractor traces.
 */

import { cacheKeyForMessages, EMPTY_GLOSSARY_HASH } from "@/core/cache";
import {
  type EntityType,
  LoreSourceKind,
  LoreSourceStatus,
} from "@/db/schema";
// LoreSourceStatus values: INGESTED | FAILED — applied below.
import { EpubAdapter } from "@/formats/epub";
import { PLACEHOLDER_RE } from "@/formats/epub/segmentation";
import { buildConstraints, glossaryHash } from "@/glossary/enforcer";
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
  type ExtractorTrace,
  parseExtractorResponse,
} from "@/llm/prompts/extractor";
import { newId } from "@/lib/id";
import { stableStringify } from "@/lib/json";
import { nowMs } from "@/lib/time";
import { openLoreDb } from "@/db/dexie";

import {
  createLoreEntry,
  findLoreEntryBySourceTerm,
  listLoreEntries,
} from "./glossary";
import { recordLoreSource } from "./lore";

export const PURPOSE_LORE_SOURCE_EXTRACT = "lore_source_extract";
export const DEFAULT_LORE_CHUNK_MAX_CHARS = 6000;
export const DEFAULT_LORE_MAX_CHAPTERS = 8;
export const DEFAULT_LORE_FAILURE_STREAK_LIMIT = 3;

export interface LoreIngestSummary {
  chunks: number;
  cached_chunks: number;
  proposed_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  failed_chunks: number;
  notes: string[];
  lore_source_id: string | null;
}

export interface LoreIngestOptions {
  model: string;
  temperature?: number | null;
  seed?: number | null;
  bypass_cache?: boolean;
  response_format?: ResponseFormat | null;
  max_chapters?: number;
  chunk_max_chars?: number;
  failure_streak_limit?: number;
  /** Auto-propose surviving candidates (defaults to `true`). */
  auto_propose?: boolean;
}

export interface IngestSourceEpubInput {
  lore_id: string;
  bytes: ArrayBuffer | Uint8Array;
  filename: string;
  source_lang: string;
  target_lang: string;
  provider: LLMProvider;
  options: LoreIngestOptions;
  notes?: string | null;
}

function emptySummary(): LoreIngestSummary {
  return {
    chunks: 0,
    cached_chunks: 0,
    proposed_count: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    failed_chunks: 0,
    notes: [],
    lore_source_id: null,
  };
}

export async function ingestSourceEpub(
  input: IngestSourceEpubInput,
): Promise<LoreIngestSummary> {
  const summary = emptySummary();

  const max_chapters =
    input.options.max_chapters ?? DEFAULT_LORE_MAX_CHAPTERS;
  const chunk_max_chars =
    input.options.chunk_max_chars ?? DEFAULT_LORE_CHUNK_MAX_CHARS;
  const streak_limit =
    input.options.failure_streak_limit ?? DEFAULT_LORE_FAILURE_STREAK_LIMIT;
  const auto_propose = input.options.auto_propose !== false;

  const adapter = new EpubAdapter();
  const book = await adapter.load(input.bytes, { filename: input.filename });
  const chapters = adapter.iterChapters(book).slice(0, max_chapters);
  const chunks = harvestProseChunks(chapters, chunk_max_chars);
  if (!chunks.length) {
    return summary;
  }

  let consecutive_failures = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const outcome = await extractChunk({
      lore_id: input.lore_id,
      source_lang: input.source_lang,
      target_lang: input.target_lang,
      source_text: chunk,
      provider: input.provider,
      options: input.options,
    });

    summary.chunks += 1;
    summary.prompt_tokens += outcome.prompt_tokens;
    summary.completion_tokens += outcome.completion_tokens;
    summary.cost_usd += outcome.cost_usd;
    if (outcome.cache_hit) summary.cached_chunks += 1;
    if (outcome.error) {
      summary.failed_chunks += 1;
      consecutive_failures += 1;
      summary.notes.push(`chunk ${i + 1}: ${outcome.error}`);
      if (streak_limit > 0 && consecutive_failures >= streak_limit) {
        summary.notes.push(
          `aborting after ${consecutive_failures} consecutive failures`,
        );
        break;
      }
      continue;
    }
    consecutive_failures = 0;

    if (auto_propose && outcome.trace) {
      const proposed = await proposeFromTrace({
        lore_id: input.lore_id,
        trace: outcome.trace,
      });
      summary.proposed_count += proposed;
    }
  }

  const lore_source = await recordLoreSource({
    lore_id: input.lore_id,
    kind: LoreSourceKind.SOURCE,
    epub_path: input.filename,
    status:
      summary.failed_chunks > 0 && summary.failed_chunks === summary.chunks
        ? LoreSourceStatus.FAILED
        : LoreSourceStatus.INGESTED,
    entries_added: summary.proposed_count,
    notes: input.notes ?? null,
  });
  summary.lore_source_id = lore_source.id;

  await openLoreDb(input.lore_id).events.add({
    project_id: input.lore_id,
    ts: nowMs(),
    kind: "lore.source_ingested",
    payload_json: JSON.stringify({
      filename: input.filename,
      chunks: summary.chunks,
      proposed_count: summary.proposed_count,
      failed_chunks: summary.failed_chunks,
      cost_usd: summary.cost_usd,
    }),
  });

  return summary;
}

/* ------------------------------------------------------------------ */
/* prose harvesting                                                    */
/* ------------------------------------------------------------------ */

function harvestProseChunks(
  chapters: ReturnType<EpubAdapter["iterChapters"]>,
  chunk_max_chars: number,
): string[] {
  const chunks: string[] = [];
  let buf = "";
  for (const ch of chapters) {
    if (!ch.tree) continue;
    const text = (ch.tree.textContent ?? "")
      .replace(PLACEHOLDER_RE, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    if (!buf) {
      buf = text;
    } else if ((buf.length + text.length + 2) <= chunk_max_chars) {
      buf = `${buf}\n\n${text}`;
    } else {
      chunks.push(buf);
      buf = text;
    }
    while (buf.length > chunk_max_chars) {
      const cut = findCutPoint(buf, chunk_max_chars);
      chunks.push(buf.slice(0, cut).trim());
      buf = buf.slice(cut).trim();
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

function findCutPoint(text: string, max: number): number {
  if (text.length <= max) return text.length;
  // Prefer paragraph break, then sentence end, then space.
  const para = text.lastIndexOf("\n\n", max);
  if (para > max * 0.5) return para;
  const sentence = Math.max(
    text.lastIndexOf(". ", max),
    text.lastIndexOf("! ", max),
    text.lastIndexOf("? ", max),
  );
  if (sentence > max * 0.5) return sentence + 2;
  const space = text.lastIndexOf(" ", max);
  return space > 0 ? space : max;
}

/* ------------------------------------------------------------------ */
/* extractChunk — single LLM call against the lore DB                  */
/* ------------------------------------------------------------------ */

interface ChunkOutcome {
  trace: ExtractorTrace | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  cache_hit: boolean;
  error: string | null;
}

async function extractChunk(input: {
  lore_id: string;
  source_lang: string;
  target_lang: string;
  source_text: string;
  provider: LLMProvider;
  options: LoreIngestOptions;
}): Promise<ChunkOutcome> {
  const db = openLoreDb(input.lore_id);

  const lore_entries = await listLoreEntries(input.lore_id);
  const constraints = buildConstraints(lore_entries);
  const g_hash = (await glossaryHash(lore_entries)) ?? EMPTY_GLOSSARY_HASH;

  const messages = buildExtractorMessages({
    source_lang: input.source_lang,
    target_lang: input.target_lang,
    source_text: input.source_text,
    glossary: constraints,
  });
  let key = await cacheKeyForMessages({
    model: input.options.model,
    messages,
    glossary_hash: g_hash,
  });
  if (input.options.bypass_cache) key = `${key}:retry`;

  const request_payload = {
    model: input.options.model,
    purpose: PURPOSE_LORE_SOURCE_EXTRACT,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: input.options.temperature ?? null,
    seed: input.options.seed ?? null,
    glossary_hash: g_hash,
  };
  const request_json = stableStringify(request_payload);

  /* --- cache lookup --- */
  if (!input.options.bypass_cache) {
    const hit = await db.llm_calls
      .where("[project_id+cache_key]")
      .equals([input.lore_id, key])
      .first();
    if (hit && hit.response_json) {
      try {
        const parsed = JSON.parse(hit.response_json) as {
          content?: string;
          trace?: ExtractorTrace;
        };
        const trace =
          parsed.trace ??
          (parsed.content ? parseExtractorResponse(parsed.content) : null);
        if (trace) {
          return {
            trace,
            prompt_tokens: 0,
            completion_tokens: 0,
            cost_usd: 0,
            cache_hit: true,
            error: null,
          };
        }
      } catch {
        // fall through to live call
      }
    }
  }

  /* --- live call --- */
  const response_format =
    input.options.response_format === null
      ? undefined
      : (input.options.response_format ?? DEFAULT_EXTRACTOR_RESPONSE_FORMAT);
  let chat;
  try {
    chat = await chatWithJsonFallback(input.provider, {
      messages,
      model: input.options.model,
      response_format,
      temperature: input.options.temperature ?? undefined,
      seed: input.options.seed ?? undefined,
    });
  } catch (err) {
    const reason =
      err instanceof LLMRateLimitError
        ? `rate limited: ${err.message}`
        : (err as Error).message;
    return {
      trace: null,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      cache_hit: false,
      error: reason,
    };
  }

  let trace: ExtractorTrace;
  try {
    trace = parseExtractorResponse(chat.content);
  } catch (err) {
    if (!(err instanceof LLMResponseError)) throw err;
    await db.llm_calls.put({
      id: newId(),
      project_id: input.lore_id,
      segment_id: null,
      purpose: PURPOSE_LORE_SOURCE_EXTRACT,
      model: chat.model,
      prompt_tokens: chat.usage?.prompt_tokens ?? null,
      completion_tokens: chat.usage?.completion_tokens ?? null,
      cost_usd: 0,
      cache_hit: 0,
      cache_key: null,
      request_json,
      response_json: stableStringify({
        content: chat.content,
        raw: chat.raw,
        error: err.message,
      }),
      created_at: nowMs(),
    });
    return {
      trace: null,
      prompt_tokens: chat.usage?.prompt_tokens ?? 0,
      completion_tokens: chat.usage?.completion_tokens ?? 0,
      cost_usd: 0,
      cache_hit: false,
      error: err.message,
    };
  }

  const prompt_tokens = chat.usage?.prompt_tokens ?? 0;
  const completion_tokens = chat.usage?.completion_tokens ?? 0;
  const cost_usd = estimateCost(chat.model, prompt_tokens, completion_tokens);

  await db.llm_calls.put({
    id: newId(),
    project_id: input.lore_id,
    segment_id: null,
    purpose: PURPOSE_LORE_SOURCE_EXTRACT,
    model: chat.model,
    prompt_tokens,
    completion_tokens,
    cost_usd,
    cache_hit: 0,
    cache_key: key,
    request_json,
    response_json: stableStringify({
      content: chat.content,
      trace,
      raw: chat.raw,
    }),
    created_at: nowMs(),
  });

  return {
    trace,
    prompt_tokens,
    completion_tokens,
    cost_usd,
    cache_hit: false,
    error: null,
  };
}

/* ------------------------------------------------------------------ */
/* proposeFromTrace                                                    */
/* ------------------------------------------------------------------ */

async function proposeFromTrace(input: {
  lore_id: string;
  trace: ExtractorTrace;
}): Promise<number> {
  let proposed = 0;
  for (const ent of input.trace.entities) {
    const source = (ent.source ?? "").trim();
    if (!source) continue;
    const target = (ent.target ?? "").trim() || source;
    const existing = await findLoreEntryBySourceTerm(
      input.lore_id,
      source,
      ent.type as EntityType,
    );
    if (existing) continue;
    await createLoreEntry(input.lore_id, {
      source_term: source,
      target_term: target,
      type: (ent.type ?? "term") as EntityType,
      status: "proposed",
      gender: null,
      notes: ent.evidence ?? null,
      source_known: true,
    });
    proposed += 1;
  }
  return proposed;
}
