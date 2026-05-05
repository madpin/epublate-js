/**
 * Project ↔ Lore-Book attachment service.
 *
 * Each project keeps a `attached_lore` table listing the Lore Books
 * it pulls glossary entries from at translation time. Each row
 * carries:
 *
 *   - `mode` — `read_only` (default) or `writable` (curator can
 *     promote new entries from the project back into the Lore Book);
 *   - `priority` — integer; higher wins when two attached Lore Books
 *     disagree on a target term (PRD F-LB-3 / F-LB-7).
 *
 * The actual cross-DB read happens at glossary-resolve time inside
 * `core/pipeline.ts`; this module is the persistence layer the
 * AttachLoreModal and the project Glossary screen call into.
 */

import { newId } from "@/lib/id";
import { nowMs } from "@/lib/time";

import { openProjectDb } from "@/db/dexie";
import {
  type AttachedLoreModeT,
  type AttachedLoreRow,
  AttachedLoreMode,
} from "@/db/schema";
import { cosineTopK } from "@/db/repo/embeddings";

import { listLoreEntries } from "./glossary";

/** Defaults applied per-attachment when the row doesn't carry overrides. */
export const DEFAULT_RETRIEVAL_TOP_K = 16;
export const DEFAULT_RETRIEVAL_MIN_SIMILARITY = 0.7;

/**
 * Attach a Lore Book to a project. Idempotent on
 * `(project_id, lore_id)` — if the row already exists, this updates
 * mode + priority instead of inserting a duplicate.
 */
export interface AttachLoreInput {
  project_id: string;
  lore_id: string;
  mode?: AttachedLoreModeT;
  /** Higher = wins on conflicts. Defaults to next-highest priority. */
  priority?: number;
  /**
   * Embedding-retrieval top-K override. `null` is the explicit
   * "flatten everything" toggle (legacy v1 behaviour); `undefined`
   * means "preserve whatever the existing row had". `0` is a synonym
   * for `null` (skip retrieval).
   */
  retrieval_top_k?: number | null;
  /**
   * Embedding-retrieval minimum cosine. Same null/undefined semantics
   * as `retrieval_top_k` above.
   */
  retrieval_min_similarity?: number | null;
}

export async function attachLoreBook(
  input: AttachLoreInput,
): Promise<AttachedLoreRow> {
  const db = openProjectDb(input.project_id);
  const existing = await db.attached_lore
    .where("[project_id+lore_path]")
    .equals([input.project_id, input.lore_id])
    .first();

  if (existing) {
    const patch: Partial<AttachedLoreRow> = {
      mode: input.mode ?? existing.mode,
      priority: input.priority ?? existing.priority,
    };
    if (input.retrieval_top_k !== undefined) {
      patch.retrieval_top_k = input.retrieval_top_k;
    }
    if (input.retrieval_min_similarity !== undefined) {
      patch.retrieval_min_similarity = input.retrieval_min_similarity;
    }
    await db.attached_lore.update(existing.id, patch);
    await db.events.add({
      project_id: input.project_id,
      ts: nowMs(),
      kind: "lore.attached",
      payload_json: JSON.stringify({
        lore_id: input.lore_id,
        mode: patch.mode,
        priority: patch.priority,
        updated: true,
      }),
    });
    return { ...existing, ...patch };
  }

  const all = await db.attached_lore
    .where("project_id")
    .equals(input.project_id)
    .toArray();
  const next_priority =
    input.priority ??
    (all.length === 0 ? 0 : Math.max(...all.map((r) => r.priority)) + 1);
  const row: AttachedLoreRow = {
    id: newId(),
    project_id: input.project_id,
    lore_path: input.lore_id,
    mode: input.mode ?? AttachedLoreMode.READ_ONLY,
    priority: next_priority,
    attached_at: nowMs(),
    retrieval_top_k: input.retrieval_top_k ?? null,
    retrieval_min_similarity: input.retrieval_min_similarity ?? null,
  };
  await db.attached_lore.put(row);
  await db.events.add({
    project_id: input.project_id,
    ts: nowMs(),
    kind: "lore.attached",
    payload_json: JSON.stringify({
      lore_id: input.lore_id,
      mode: row.mode,
      priority: row.priority,
      updated: false,
    }),
  });
  return row;
}

export async function detachLoreBook(
  project_id: string,
  lore_id: string,
): Promise<void> {
  const db = openProjectDb(project_id);
  const existing = await db.attached_lore
    .where("[project_id+lore_path]")
    .equals([project_id, lore_id])
    .first();
  if (!existing) return;
  await db.attached_lore.delete(existing.id);
  await db.events.add({
    project_id,
    ts: nowMs(),
    kind: "lore.detached",
    payload_json: JSON.stringify({ lore_id }),
  });
}

export async function listAttachedLore(
  project_id: string,
): Promise<AttachedLoreRow[]> {
  const db = openProjectDb(project_id);
  const rows = await db.attached_lore
    .where("project_id")
    .equals(project_id)
    .toArray();
  // Highest priority first so the merge step at translate time can
  // walk the array and let the first match win.
  rows.sort((a, b) => b.priority - a.priority);
  return rows;
}

export async function setAttachedLoreMode(
  project_id: string,
  lore_id: string,
  mode: AttachedLoreModeT,
): Promise<void> {
  const db = openProjectDb(project_id);
  const existing = await db.attached_lore
    .where("[project_id+lore_path]")
    .equals([project_id, lore_id])
    .first();
  if (!existing) return;
  await db.attached_lore.update(existing.id, { mode });
  await db.events.add({
    project_id,
    ts: nowMs(),
    kind: "lore.mode_changed",
    payload_json: JSON.stringify({ lore_id, mode }),
  });
}

export async function setAttachedLorePriority(
  project_id: string,
  lore_id: string,
  priority: number,
): Promise<void> {
  const db = openProjectDb(project_id);
  const existing = await db.attached_lore
    .where("[project_id+lore_path]")
    .equals([project_id, lore_id])
    .first();
  if (!existing) return;
  await db.attached_lore.update(existing.id, { priority });
  await db.events.add({
    project_id,
    ts: nowMs(),
    kind: "lore.priority_changed",
    payload_json: JSON.stringify({ lore_id, priority }),
  });
}

/**
 * Optional embedding-retrieval context for `resolveProjectGlossaryWithLore`.
 *
 * When provided, each attached Lore Book is filtered down to its top-K
 * entries closest to the segment vector (per-attachment overrides
 * win over the global defaults). When `segment_vec` is omitted, the
 * resolver falls back to the legacy "flatten everything" behaviour.
 */
export interface LoreRetrievalContext {
  /** Encoder output for the current segment's source text. */
  segment_vec: Float32Array;
  /** Encoder identifier; matches the `model` column in `embeddings`. */
  embedding_model: string;
  /** Override the default top-K when an attachment doesn't carry one. */
  default_top_k?: number;
  /** Override the default min similarity when an attachment doesn't carry one. */
  default_min_similarity?: number;
}

/**
 * Build the projected glossary state used by the translator pipeline.
 *
 * Combines the project's own glossary entries with the glossary entries
 * of every attached Lore Book. Lore-Book entries are tagged with their
 * source `lore_id` (in `entry.first_seen_segment_id`-style metadata is
 * not appropriate here — we use a side-band map). Higher-priority Lore
 * Books win over lower-priority ones; the project's own entries are
 * authoritative and *always* win over any attached Lore Book.
 *
 * Conflict resolution rules (mirrors PRD F-LB-3 / F-LB-7):
 *
 *   - dedup by `(source_term, type)` for source-keyed entries;
 *   - dedup by `(target_term, type, source_known=false)` for
 *     target-only entries;
 *   - the first occurrence in walk order wins (project → highest
 *     priority lore → … → lowest priority lore).
 *
 * When `retrieval` is provided, the per-Lore-Book entries are
 * pre-filtered to the top-K cosine matches against the segment vector.
 * When `retrieval` is `null` / `undefined`, every entry from every
 * attached Lore Book is considered (legacy v1 behaviour).
 */
export async function resolveProjectGlossaryWithLore(
  project_id: string,
  project_entries: ReadonlyArray<
    Awaited<
      ReturnType<typeof import("@/db/repo/glossary").listGlossaryEntries>
    >[number]
  >,
  retrieval: LoreRetrievalContext | null = null,
): Promise<
  Array<
    Awaited<
      ReturnType<typeof import("@/db/repo/glossary").listGlossaryEntries>
    >[number]
  >
> {
  type EntryT = Awaited<
    ReturnType<typeof import("@/db/repo/glossary").listGlossaryEntries>
  >[number];
  const attached = await listAttachedLore(project_id);
  if (attached.length === 0) return [...project_entries];
  const seen_source = new Set<string>();
  const seen_target_only = new Set<string>();
  const merged: EntryT[] = [];

  for (const e of project_entries) {
    if (e.entry.source_term && e.entry.source_known !== false) {
      const key = `${e.entry.type}::${e.entry.source_term.toLowerCase()}`;
      seen_source.add(key);
    } else {
      const key = `${e.entry.type}::${e.entry.target_term.toLowerCase()}`;
      seen_target_only.add(key);
    }
    merged.push(e);
  }

  const default_top_k =
    retrieval?.default_top_k ?? DEFAULT_RETRIEVAL_TOP_K;
  const default_min_similarity =
    retrieval?.default_min_similarity ?? DEFAULT_RETRIEVAL_MIN_SIMILARITY;

  for (const att of attached) {
    let lore_entries: EntryT[];
    try {
      lore_entries = await listLoreEntries(att.lore_path);
    } catch {
      continue;
    }
    if (retrieval) {
      const top_k_setting =
        att.retrieval_top_k != null ? att.retrieval_top_k : default_top_k;
      const min_sim =
        att.retrieval_min_similarity != null
          ? att.retrieval_min_similarity
          : default_min_similarity;
      // `top_k <= 0` is the explicit "skip retrieval, fall back to
      // flat merge" knob. The Lore-Book attach modal exposes it as a
      // checkbox to keep parity with the v1 flow.
      if (top_k_setting > 0) {
        const non_proposed_ids = new Set(
          lore_entries
            .filter((e) => e.entry.status !== "proposed")
            .map((e) => e.entry.id),
        );
        if (non_proposed_ids.size === 0) continue;
        let hits: Awaited<ReturnType<typeof cosineTopK>>;
        try {
          hits = await cosineTopK(
            "lore",
            att.lore_path,
            "glossary_entry",
            retrieval.embedding_model,
            retrieval.segment_vec,
            {
              k: top_k_setting,
              min_similarity: min_sim,
              filter: non_proposed_ids,
            },
          );
        } catch {
          hits = [];
        }
        if (hits.length > 0) {
          const hit_ids = new Set(hits.map((h) => h.ref_id));
          lore_entries = lore_entries.filter((e) => hit_ids.has(e.entry.id));
        } else {
          // No embeddings for this Lore Book yet. Skip the entire
          // attachment rather than blasting every entry into the
          // prompt — that's what the legacy path is for.
          continue;
        }
      }
    }
    for (const e of lore_entries) {
      if (e.entry.status === "proposed") continue;
      if (e.entry.source_term && e.entry.source_known !== false) {
        const key = `${e.entry.type}::${e.entry.source_term.toLowerCase()}`;
        if (seen_source.has(key)) continue;
        seen_source.add(key);
      } else {
        const key = `${e.entry.type}::${e.entry.target_term.toLowerCase()}`;
        if (seen_target_only.has(key)) continue;
        seen_target_only.add(key);
      }
      merged.push(e);
    }
  }

  return merged;
}
