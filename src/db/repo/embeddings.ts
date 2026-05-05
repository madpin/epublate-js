/**
 * Embeddings repo (per-project + per-Lore-Book Dexie databases).
 *
 * Backs the retrieval layer added in v2 of the schema:
 *
 * - `scope: "segment"` — used in per-project DBs, keyed by `segment.id`.
 *   Powers the `relevant` cross-chapter context mode.
 * - `scope: "glossary_entry"` — used in both per-project DBs (for the
 *   project-side glossary) and per-Lore-Book DBs (for Lore-Book
 *   entries). Powers proposed-entry hints + Lore-Book retrieval.
 *
 * Cosine top-K is a linear scan over the rows whose `[scope+model]`
 * compound index matches; this is fine up to ~50k vectors per project
 * (~150 ms in Chrome, ~300 ms in Safari for 1536-dim vectors).
 *
 * The plan refers to three logically separate tables (`segment_embeddings`,
 * `glossary_entry_embeddings`, `lore_glossary_embeddings`); they share
 * one Dexie store under the hood to keep migrations simple, with the
 * `scope` column acting as the discriminator.
 */

import { newId } from "@/lib/id";
import { nowMs } from "@/lib/time";

import { openLoreDb, openProjectDb } from "../dexie";
import { type EmbeddingRow } from "../schema";
import {
  cosine,
  packFloat32,
  unpackFloat32,
} from "@/llm/embeddings/base";

export type EmbeddingScope = EmbeddingRow["scope"];

export type EmbeddingDb = "project" | "lore";

function dbFor(target: EmbeddingDb, dbId: string) {
  return target === "lore" ? openLoreDb(dbId) : openProjectDb(dbId);
}

export interface UpsertEmbeddingInput {
  scope: EmbeddingScope;
  ref_id: string;
  model: string;
  vector: Float32Array;
}

/**
 * Insert or replace the row for `(scope, ref_id, model)`. Idempotent
 * by design — re-embedding the same segment with the same model
 * overwrites the old row so callers don't need to do a pre-check.
 */
export async function upsertEmbedding(
  target: EmbeddingDb,
  dbId: string,
  input: UpsertEmbeddingInput,
): Promise<EmbeddingRow> {
  const db = dbFor(target, dbId);
  const existing = await db.embeddings
    .where("[scope+ref_id+model]")
    .equals([input.scope, input.ref_id, input.model])
    .first();
  const row: EmbeddingRow = {
    id: existing?.id ?? newId(),
    scope: input.scope,
    ref_id: input.ref_id,
    model: input.model,
    dim: input.vector.length,
    vector: packFloat32(input.vector),
    created_at: existing?.created_at ?? nowMs(),
  };
  await db.embeddings.put(row);
  return row;
}

export async function bulkUpsertEmbeddings(
  target: EmbeddingDb,
  dbId: string,
  inputs: UpsertEmbeddingInput[],
): Promise<void> {
  if (!inputs.length) return;
  const db = dbFor(target, dbId);
  await db.transaction("rw", db.embeddings, async () => {
    const ts = nowMs();
    const rows: EmbeddingRow[] = [];
    for (const input of inputs) {
      const existing = await db.embeddings
        .where("[scope+ref_id+model]")
        .equals([input.scope, input.ref_id, input.model])
        .first();
      rows.push({
        id: existing?.id ?? newId(),
        scope: input.scope,
        ref_id: input.ref_id,
        model: input.model,
        dim: input.vector.length,
        vector: packFloat32(input.vector),
        created_at: existing?.created_at ?? ts,
      });
    }
    await db.embeddings.bulkPut(rows);
  });
}

export async function getEmbedding(
  target: EmbeddingDb,
  dbId: string,
  scope: EmbeddingScope,
  ref_id: string,
  model: string,
): Promise<EmbeddingRow | undefined> {
  const db = dbFor(target, dbId);
  return db.embeddings
    .where("[scope+ref_id+model]")
    .equals([scope, ref_id, model])
    .first();
}

export async function listEmbeddingsByScope(
  target: EmbeddingDb,
  dbId: string,
  scope: EmbeddingScope,
  model: string,
): Promise<EmbeddingRow[]> {
  const db = dbFor(target, dbId);
  return db.embeddings
    .where("[scope+model]")
    .equals([scope, model])
    .toArray();
}

export async function deleteEmbeddingsForRef(
  target: EmbeddingDb,
  dbId: string,
  scope: EmbeddingScope,
  ref_id: string,
): Promise<void> {
  const db = dbFor(target, dbId);
  const rows = await db.embeddings
    .where("[scope+ref_id+model]")
    .between([scope, ref_id, ""], [scope, ref_id, "\uffff"], true, true)
    .toArray();
  if (!rows.length) return;
  await db.embeddings.bulkDelete(rows.map((r) => r.id));
}

export async function countEmbeddingsByScope(
  target: EmbeddingDb,
  dbId: string,
  scope: EmbeddingScope,
  model: string,
): Promise<number> {
  const db = dbFor(target, dbId);
  return db.embeddings
    .where("[scope+model]")
    .equals([scope, model])
    .count();
}

export interface CosineHit {
  ref_id: string;
  model: string;
  similarity: number;
}

export interface CosineTopKOptions {
  /** Number of hits to return after filtering. */
  k: number;
  /** Drop rows below this cosine similarity. Default `0`. */
  min_similarity?: number;
  /**
   * Optional `ref_id` allow-list. When provided, rows whose `ref_id`
   * isn't in the set are skipped. Used for "rank only segments
   * earlier in spine order" or "rank only entries from this attached
   * Lore Book".
   */
  filter?: ReadonlySet<string>;
  /** Skip the row whose `ref_id` matches (e.g. self-similarity). */
  exclude_ref_id?: string | null;
}

/**
 * Linear-scan top-K cosine similarity against `(scope, model)`.
 *
 * Reads every matching row, computes cosine, keeps a rolling
 * top-K with insertion sort. Cheap up to ~50k rows per scope.
 *
 * Returns hits sorted by descending similarity. Stable for ties on
 * similarity is not guaranteed — callers that need a deterministic
 * order should sort by `(similarity desc, ref_id asc)` themselves.
 */
export async function cosineTopK(
  target: EmbeddingDb,
  dbId: string,
  scope: EmbeddingScope,
  model: string,
  query: Float32Array,
  options: CosineTopKOptions,
): Promise<CosineHit[]> {
  const k = Math.max(0, Math.floor(options.k));
  if (k === 0) return [];
  const min_similarity =
    typeof options.min_similarity === "number" &&
    Number.isFinite(options.min_similarity)
      ? options.min_similarity
      : 0;
  const rows = await listEmbeddingsByScope(target, dbId, scope, model);
  const hits: CosineHit[] = [];
  for (const row of rows) {
    if (options.exclude_ref_id && row.ref_id === options.exclude_ref_id) {
      continue;
    }
    if (options.filter && !options.filter.has(row.ref_id)) continue;
    if (row.dim !== query.length) continue; // model mismatch — skip
    const vec = unpackFloat32(row.vector);
    const sim = cosine(query, vec);
    if (sim < min_similarity) continue;
    hits.push({ ref_id: row.ref_id, model: row.model, similarity: sim });
  }
  hits.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    return a.ref_id < b.ref_id ? -1 : a.ref_id > b.ref_id ? 1 : 0;
  });
  return hits.slice(0, k);
}
