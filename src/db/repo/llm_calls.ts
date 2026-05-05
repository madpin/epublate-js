/**
 * LLM-call repo (mirrors `epublate.db.repo.llm_call`).
 *
 * Every call to a chat-completions endpoint — translator, helper,
 * extractor — gets one row in `llm_calls` so the audit pane and cost
 * meter can reconstruct what we sent and what we got back. Cache hits
 * still get a fresh row with `cache_hit = 1` and `cost_usd = 0` so
 * stats aggregations never collapse misses and hits.
 *
 * Cache lookups go through `findLlmCallByCacheKey`: the compound index
 * `[project_id+cache_key]` declared in `db/dexie.ts` makes it a single
 * IDB cursor lookup.
 */

import { openProjectDb } from "../dexie";
import { type LlmCallRow } from "../schema";

export interface InsertLlmCallInput {
  id: string;
  project_id: string;
  segment_id: string | null;
  purpose: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  cache_hit: boolean;
  cache_key: string | null;
  request_json: string | null;
  response_json: string | null;
  created_at?: number;
}

export async function insertLlmCall(
  projectId: string,
  input: InsertLlmCallInput,
): Promise<void> {
  const row: LlmCallRow = {
    id: input.id,
    project_id: input.project_id,
    segment_id: input.segment_id,
    purpose: input.purpose,
    model: input.model,
    prompt_tokens: input.prompt_tokens,
    completion_tokens: input.completion_tokens,
    cost_usd: input.cost_usd,
    cache_hit: input.cache_hit ? 1 : 0,
    cache_key: input.cache_key,
    request_json: input.request_json,
    response_json: input.response_json,
    created_at: input.created_at ?? Date.now(),
  };
  const db = openProjectDb(projectId);
  await db.llm_calls.put(row);
}

export async function findLlmCallByCacheKey(
  projectId: string,
  cacheKey: string,
): Promise<LlmCallRow | undefined> {
  const db = openProjectDb(projectId);
  return db.llm_calls
    .where("[project_id+cache_key]")
    .equals([projectId, cacheKey])
    .first();
}

export async function listLlmCallsForSegment(
  projectId: string,
  segmentId: string,
): Promise<LlmCallRow[]> {
  const db = openProjectDb(projectId);
  return db.llm_calls
    .where("segment_id")
    .equals(segmentId)
    .reverse()
    .sortBy("created_at");
}

export async function recentLlmCalls(
  projectId: string,
  limit = 50,
): Promise<LlmCallRow[]> {
  const db = openProjectDb(projectId);
  const rows = await db.llm_calls
    .where("project_id")
    .equals(projectId)
    .reverse()
    .sortBy("created_at");
  return rows.slice(0, limit);
}
