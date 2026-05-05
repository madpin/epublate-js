/**
 * Lore Book glossary repo.
 *
 * Lore Books reuse the `glossary_entries` / `glossary_aliases` /
 * `glossary_revisions` tables that translation projects use, but they
 * live in a separate Dexie database (`epublate-lore-<id>`). The
 * project-side glossary repo (`db/repo/glossary.ts`) hard-codes
 * `openProjectDb` and would address the wrong database, so the
 * Lore-Book-specific pieces live here.
 *
 * Only the operations a Lore Book actually performs are exposed:
 *   - list / create / update / delete entries
 *   - set aliases
 *   - update revisions when the target term changes
 *
 * Translation-time concepts (entity mentions, occurrence lookups,
 * cascade re-translation) are deliberately absent — those are
 * project-only.
 */

import { newId } from "@/lib/id";
import { nowMs } from "@/lib/time";

import { openLoreDb } from "@/db/dexie";
import {
  type AliasSide,
  type EntityType,
  type GenderTag,
  type GlossaryAliasRow,
  type GlossaryEntryRow,
  type GlossaryRevisionRow,
  type GlossaryStatusT,
} from "@/db/schema";
import type { GlossaryEntryWithAliases } from "@/glossary/models";

import { refreshLoreLibraryCounts } from "./lore";
import { embedAndStoreLoreEntries } from "./embeddings";

export interface CreateLoreEntryInput {
  source_term: string | null;
  target_term: string;
  type?: EntityType;
  status?: GlossaryStatusT;
  gender?: GenderTag | null;
  notes?: string | null;
  source_aliases?: readonly string[];
  target_aliases?: readonly string[];
  /** False ⇒ target-only (PRD F-LB-9). Defaults to false when source_term is null. */
  source_known?: boolean;
}

function dedupAliases(
  canonical: string | null,
  aliases: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (canonical) seen.add(canonical);
  for (const a of aliases) {
    if (a && !seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

function rowToWith(
  entry: GlossaryEntryRow,
  src: string[],
  tgt: string[],
): GlossaryEntryWithAliases {
  return {
    entry,
    source_aliases: [...src].sort(),
    target_aliases: [...tgt].sort(),
  };
}

export async function createLoreEntry(
  lore_id: string,
  input: CreateLoreEntryInput,
): Promise<GlossaryEntryWithAliases> {
  const db = openLoreDb(lore_id);
  const source_known =
    input.source_known ?? (input.source_term !== null);
  if (input.source_term === null && source_known) {
    throw new Error(
      "source_known=true requires a non-empty source_term; for target-only Lore Book entries pass source_known=false",
    );
  }
  const now = nowMs();
  const entry: GlossaryEntryRow = {
    id: newId(),
    project_id: lore_id,
    type: input.type ?? "term",
    source_term: input.source_term,
    target_term: input.target_term,
    gender: input.gender ?? null,
    status: input.status ?? "proposed",
    notes: input.notes ?? null,
    first_seen_segment_id: null,
    created_at: now,
    updated_at: now,
    source_known,
  };
  const src = dedupAliases(input.source_term, input.source_aliases ?? []);
  const tgt = dedupAliases(input.target_term, input.target_aliases ?? []);
  const aliasRows: GlossaryAliasRow[] = [
    ...src.map<GlossaryAliasRow>((text) => ({
      id: newId(),
      entry_id: entry.id,
      side: "source" as AliasSide,
      text,
    })),
    ...tgt.map<GlossaryAliasRow>((text) => ({
      id: newId(),
      entry_id: entry.id,
      side: "target" as AliasSide,
      text,
    })),
  ];

  await db.transaction(
    "rw",
    db.glossary_entries,
    db.glossary_aliases,
    async () => {
      await db.glossary_entries.put(entry);
      if (aliasRows.length) await db.glossary_aliases.bulkPut(aliasRows);
    },
  );
  await refreshLoreLibraryCounts(lore_id);
  // Embed best-effort — failure must not break entry creation.
  void embedAndStoreLoreEntries(lore_id, [entry]).catch(() => {});
  return rowToWith(entry, src, tgt);
}

export async function listLoreEntries(
  lore_id: string,
): Promise<GlossaryEntryWithAliases[]> {
  const db = openLoreDb(lore_id);
  const entries = await db.glossary_entries
    .where("project_id")
    .equals(lore_id)
    .toArray();
  entries.sort((a, b) => {
    const sa = a.source_term ?? a.target_term;
    const sb = b.source_term ?? b.target_term;
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  if (!entries.length) return [];
  const aliasRows = await db.glossary_aliases
    .where("entry_id")
    .anyOf(entries.map((e) => e.id))
    .toArray();
  const buckets = new Map<string, { source: string[]; target: string[] }>();
  for (const e of entries) buckets.set(e.id, { source: [], target: [] });
  for (const r of aliasRows) {
    const bucket = buckets.get(r.entry_id);
    if (!bucket) continue;
    if (r.side === "source") bucket.source.push(r.text);
    else bucket.target.push(r.text);
  }
  return entries.map((e) => {
    const b = buckets.get(e.id) ?? { source: [], target: [] };
    return rowToWith(e, b.source, b.target);
  });
}

export interface UpdateLoreEntryInput {
  target_term?: string;
  status?: GlossaryStatusT;
  type?: EntityType;
  gender?: GenderTag | null;
  notes?: string | null;
  reason?: string | null;
}

export async function updateLoreEntry(
  lore_id: string,
  entry_id: string,
  patch: UpdateLoreEntryInput,
): Promise<GlossaryEntryRow> {
  const db = openLoreDb(lore_id);
  let updated: GlossaryEntryRow | null = null;
  await db.transaction(
    "rw",
    db.glossary_entries,
    db.glossary_revisions,
    async () => {
      const existing = await db.glossary_entries.get(entry_id);
      if (!existing) throw new Error(`lore entry not found: ${entry_id}`);
      const next: GlossaryEntryRow = { ...existing };
      let changed = false;
      let target_changed = false;
      let status_changed = false;
      if (
        patch.target_term !== undefined &&
        patch.target_term !== existing.target_term
      ) {
        next.target_term = patch.target_term;
        target_changed = true;
        changed = true;
      }
      if (patch.status !== undefined && patch.status !== existing.status) {
        next.status = patch.status;
        status_changed = true;
        changed = true;
      }
      if (patch.type !== undefined && patch.type !== existing.type) {
        next.type = patch.type;
        changed = true;
      }
      if (patch.gender !== undefined && patch.gender !== existing.gender) {
        next.gender = patch.gender;
        changed = true;
      }
      if (patch.notes !== undefined && patch.notes !== existing.notes) {
        next.notes = patch.notes;
        changed = true;
      }
      if (!changed) {
        updated = existing;
        return;
      }
      next.updated_at = nowMs();
      await db.glossary_entries.put(next);
      if (target_changed || status_changed) {
        const rev: GlossaryRevisionRow = {
          id: newId(),
          entry_id,
          prev_target_term: existing.target_term,
          new_target_term: target_changed
            ? next.target_term
            : existing.target_term,
          reason:
            patch.reason ??
            (status_changed && !target_changed
              ? `status: ${existing.status} -> ${next.status}`
              : null),
          created_at: nowMs(),
        };
        await db.glossary_revisions.put(rev);
      }
      updated = next;
    },
  );
  if (!updated) throw new Error(`lore entry not found: ${entry_id}`);
  await refreshLoreLibraryCounts(lore_id);
  // Re-embed if any of the embedded fields changed (target_term /
  // notes — type and status don't shift the embedding text).
  void embedAndStoreLoreEntries(lore_id, [updated]).catch(() => {});
  return updated;
}

export async function deleteLoreEntry(
  lore_id: string,
  entry_id: string,
): Promise<void> {
  const db = openLoreDb(lore_id);
  await db.transaction(
    "rw",
    db.glossary_entries,
    db.glossary_aliases,
    db.glossary_revisions,
    async () => {
      await db.glossary_entries.delete(entry_id);
      await db.glossary_aliases.where("entry_id").equals(entry_id).delete();
      await db.glossary_revisions.where("entry_id").equals(entry_id).delete();
    },
  );
  await refreshLoreLibraryCounts(lore_id);
  const { deleteEmbeddingsForRef } = await import("@/db/repo/embeddings");
  await deleteEmbeddingsForRef("lore", lore_id, "glossary_entry", entry_id);
}

export async function setLoreEntryAliases(
  lore_id: string,
  entry_id: string,
  opts: {
    source_aliases?: readonly string[];
    target_aliases?: readonly string[];
  },
): Promise<void> {
  const db = openLoreDb(lore_id);
  const src = dedupAliases(null, opts.source_aliases ?? []);
  const tgt = dedupAliases(null, opts.target_aliases ?? []);
  const payload: GlossaryAliasRow[] = [
    ...src.map<GlossaryAliasRow>((text) => ({
      id: newId(),
      entry_id,
      side: "source" as AliasSide,
      text,
    })),
    ...tgt.map<GlossaryAliasRow>((text) => ({
      id: newId(),
      entry_id,
      side: "target" as AliasSide,
      text,
    })),
  ];
  await db.transaction("rw", db.glossary_aliases, async () => {
    await db.glossary_aliases.where("entry_id").equals(entry_id).delete();
    if (payload.length) await db.glossary_aliases.bulkPut(payload);
  });
}

/**
 * Match a non-target-only (`source_known=true`) entry by `source_term`
 * and `type`. Used by the import-project conflict resolver.
 */
export async function findLoreEntryBySourceTerm(
  lore_id: string,
  source_term: string,
  type?: EntityType,
): Promise<GlossaryEntryRow | undefined> {
  const db = openLoreDb(lore_id);
  const matches = await db.glossary_entries
    .where("source_term")
    .equals(source_term)
    .toArray();
  return matches.find(
    (m) =>
      m.project_id === lore_id &&
      m.source_known !== false &&
      (type === undefined || m.type === type),
  );
}
