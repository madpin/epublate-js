/**
 * Embedding inventory + re-embed orchestration.
 *
 * Embeddings are vector-space-specific: rows tagged `model = "X"`
 * cannot be compared against a query vector produced by `model =
 * "Y"`, even when both have the same dim. The retrieval layer
 * already filters by `(scope, model)` so a stale row never
 * pollutes the top-K — but it also means the curator silently
 * loses the work when they switch the active model.
 *
 * This module makes that visible:
 *
 * - {@link getProjectEmbeddingInventory} returns a histogram of
 *   `(scope, model)` rows the project carries, plus a "missing"
 *   count for the active model. The Settings UI surfaces this so
 *   curators can decide whether to re-embed or undo the change.
 * - {@link reembedProject} re-runs the segment-embedding pass and
 *   the project-glossary embed step against the active provider,
 *   producing fresh vectors keyed under its model.
 * - {@link purgeStaleEmbeddings} drops rows whose `model` differs
 *   from the active one. Useful after a re-embed to reclaim the
 *   IndexedDB quota that orphaned vectors hold.
 *
 * All operations are best-effort: failures are surfaced via thrown
 * errors so the caller can decide whether to abort, but a partial
 * result is still useful (the next re-embed picks up where this
 * one left off).
 */

import { openLoreDb, openProjectDb } from "@/db/dexie";
import { listGlossaryEntries } from "@/db/repo/glossary";
import { type EmbeddingRow, type GlossaryEntryRow } from "@/db/schema";
import { type EmbeddingProvider } from "./base";
import { embedProjectGlossaryEntriesWithProvider } from "@/glossary/embeddings";
import { embedLoreEntriesWithProvider } from "@/lore/embeddings";
import { listLoreEntries } from "@/lore/glossary";
import { runEmbeddingPass, type EmbeddingPassSummary } from "@/core/embedding_pass";

/** Histogram of embedding rows, keyed by `(scope, model)`. */
export interface EmbeddingScopeStats {
  /** Total entities in this scope (segments, glossary entries, …). */
  total: number;
  /** Rows under the active model (or all rows when `active_model = null`). */
  active: number;
  /** Rows under any other model. These cannot be ranked by `cosineTopK`. */
  stale: number;
  /** Per-model counts, in deterministic order. */
  by_model: Array<{ model: string; count: number }>;
}

export interface ProjectEmbeddingInventory {
  /** Currently configured model (`null` ⇒ embeddings are off). */
  active_model: string | null;
  /** Stats for `scope = "segment"`. */
  segment: EmbeddingScopeStats;
  /** Stats for `scope = "glossary_entry"` rows owned by the project. */
  glossary_entry: EmbeddingScopeStats;
  /** Lore-Book glossary stats, broken out per attached Lore Book. */
  lore_books: Array<{
    lore_id: string;
    name: string | null;
    glossary_entry: EmbeddingScopeStats;
  }>;
}

/**
 * Build the per-project inventory described above. Reads from
 * IndexedDB only — never hits the network.
 */
export async function getProjectEmbeddingInventory(
  project_id: string,
  active_model: string | null,
): Promise<ProjectEmbeddingInventory> {
  const db = openProjectDb(project_id);
  const segments = await db.segments.toArray();
  const total_segments = segments.filter(
    (s) => s.source_text && s.source_text.trim().length > 0,
  ).length;
  const glossary = await listGlossaryEntries(project_id);
  const total_glossary = glossary.length;

  const all_rows = await db.embeddings.toArray();
  const segment_rows = all_rows.filter((r) => r.scope === "segment");
  const glossary_rows = all_rows.filter((r) => r.scope === "glossary_entry");

  const segment_active_refs = countActiveRefs(segment_rows, active_model);
  const segment = {
    total: total_segments,
    active: segment_active_refs.active,
    stale: segment_active_refs.stale,
    by_model: histogram(segment_rows),
  };
  const glossary_active_refs = countActiveRefs(glossary_rows, active_model);
  const glossary_stats: EmbeddingScopeStats = {
    total: total_glossary,
    active: glossary_active_refs.active,
    stale: glossary_active_refs.stale,
    by_model: histogram(glossary_rows),
  };

  // Attached Lore Books — each Lore Book is its own Dexie DB so we
  // need to walk them individually. Gracefully ignore Lore Books
  // that have been detached or whose store can't be opened.
  const attached = await db.attached_lore.toArray();
  const lore_books: ProjectEmbeddingInventory["lore_books"] = [];
  for (const att of attached) {
    try {
      const lore_db = openLoreDb(att.lore_path);
      const meta = await lore_db.lore_meta.get(att.lore_path);
      const lore_total = (await listLoreEntries(att.lore_path)).length;
      const rows = await lore_db.embeddings
        .where("scope")
        .equals("glossary_entry")
        .toArray();
      const refs = countActiveRefs(rows, active_model);
      lore_books.push({
        lore_id: att.lore_path,
        name: meta?.description?.trim() || null,
        glossary_entry: {
          total: lore_total,
          active: refs.active,
          stale: refs.stale,
          by_model: histogram(rows),
        },
      });
    } catch {
      // Attached Lore Book whose DB couldn't be opened — skip it
      // rather than failing the whole inventory call.
    }
  }

  return {
    active_model,
    segment,
    glossary_entry: glossary_stats,
    lore_books,
  };
}

interface ActiveRefStats {
  /** Distinct refs that have a row matching the active model. */
  active: number;
  /** Distinct refs with rows but none under the active model. */
  stale: number;
}

function countActiveRefs(
  rows: EmbeddingRow[],
  active_model: string | null,
): ActiveRefStats {
  // Walk per-ref so we don't double-count the same segment that has
  // both a fresh and a stale row. The "stale" count is the number
  // of refs that have *only* non-active rows.
  const by_ref = new Map<string, Set<string>>();
  for (const row of rows) {
    let set = by_ref.get(row.ref_id);
    if (!set) {
      set = new Set<string>();
      by_ref.set(row.ref_id, set);
    }
    set.add(row.model);
  }
  let active = 0;
  let stale = 0;
  for (const set of by_ref.values()) {
    if (active_model && set.has(active_model)) {
      active += 1;
      continue;
    }
    if (set.size > 0) stale += 1;
  }
  return { active, stale };
}

function histogram(rows: EmbeddingRow[]): Array<{ model: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.model, (counts.get(row.model) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([model, count]) => ({ model, count }));
}

export interface ReembedSummary {
  /** Pass summary from `runEmbeddingPass`. `null` when embeddings are off. */
  segments: EmbeddingPassSummary | null;
  /** How many project glossary entries got fresh vectors. */
  glossary_entries: number;
  /** Lore-Book entries re-embedded (cumulative across attached books). */
  lore_entries: number;
  /** How many stale rows were deleted by `purge_stale: true`. */
  purged: number;
}

export interface ReembedOptions {
  /** Forwarded to `runEmbeddingPass`. */
  max_segments?: number | null;
  /** Forwarded to `runEmbeddingPass`. */
  batch_size_override?: number | null;
  /** Drop rows under non-active models when the new pass succeeds. */
  purge_stale?: boolean;
  /** Cancel the pass + glossary embed mid-flight. */
  signal?: AbortSignal;
  /**
   * Skip Lore-Book re-embedding. Lore Books are shared across
   * projects — a re-embed run from project A re-keys vectors that
   * project B may rely on. Default is `true` so a single project's
   * "Re-embed everything" doesn't accidentally rewrite the shared
   * Lore-Book stores.
   */
  skip_lore?: boolean;
}

/**
 * Re-embed every segment + project-glossary entry under the active
 * provider's model. Best-effort — partial successes still return a
 * non-null `segments` summary so the curator can see progress.
 */
export async function reembedProject(
  project_id: string,
  provider: EmbeddingProvider,
  options: ReembedOptions = {},
): Promise<ReembedSummary> {
  const segment_summary = await runEmbeddingPass(project_id, provider, {
    max_segments: options.max_segments ?? null,
    batch_size_override: options.batch_size_override ?? null,
    signal: options.signal,
  });

  const glossary = await listGlossaryEntries(project_id);
  const entries: GlossaryEntryRow[] = glossary.map((g) => g.entry);
  let glossary_count = 0;
  if (entries.length) {
    try {
      glossary_count = await embedProjectGlossaryEntriesWithProvider(
        project_id,
        entries,
        { provider, signal: options.signal },
      );
    } catch {
      // Glossary embedding is a soft optimization — let the segment
      // pass result stand even when the glossary embed call trips.
    }
  }

  let lore_count = 0;
  if (!options.skip_lore && options.skip_lore !== undefined) {
    // Caller explicitly opted in to Lore-Book re-embedding. We
    // re-embed every attached Lore Book against `provider` so the
    // curator doesn't have to re-attach them manually. This *does*
    // rewrite vectors that other projects may share.
    lore_count = await reembedAttachedLoreBooks(
      project_id,
      provider,
      options.signal,
    );
  }

  let purged = 0;
  if (options.purge_stale) {
    purged = await purgeStaleEmbeddings(project_id, provider.model);
  }

  return {
    segments: segment_summary,
    glossary_entries: glossary_count,
    lore_entries: lore_count,
    purged,
  };
}

async function reembedAttachedLoreBooks(
  project_id: string,
  provider: EmbeddingProvider,
  signal?: AbortSignal,
): Promise<number> {
  const db = openProjectDb(project_id);
  const attached = await db.attached_lore.toArray();
  let total = 0;
  for (const att of attached) {
    if (signal?.aborted) break;
    try {
      const entries = await listLoreEntries(att.lore_path);
      const rows = entries.map((e) => e.entry);
      if (!rows.length) continue;
      total += await embedLoreEntriesWithProvider(att.lore_path, rows, {
        provider,
        signal,
      });
    } catch {
      // Skip a Lore Book that fails — a single missing model
      // shouldn't block the rest of the re-embed.
    }
  }
  return total;
}

/**
 * Drop every embedding row whose `model` differs from `keep_model`.
 * Returns the number of rows deleted across both segment and
 * glossary scopes (project DB only — Lore-Book DBs are owned by
 * the Lore-Book project and aren't touched here).
 */
export async function purgeStaleEmbeddings(
  project_id: string,
  keep_model: string,
): Promise<number> {
  const db = openProjectDb(project_id);
  const stale_ids = await db.embeddings
    .filter((row) => row.model !== keep_model)
    .primaryKeys();
  if (!stale_ids.length) return 0;
  await db.embeddings.bulkDelete(stale_ids);
  return stale_ids.length;
}
