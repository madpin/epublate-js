/**
 * Glossary repo (mirrors `epublate.db.repo` glossary functions).
 *
 * Wraps Dexie operations on `glossary_entries`, `glossary_aliases`,
 * `glossary_revisions`, and `entity_mentions`. Each operation runs
 * inside a single Dexie transaction so the entry, its aliases, and
 * any revision/mention updates always commit together.
 */

import { newId } from "@/lib/id";
import { nowMs } from "@/lib/time";
import type {
  GlossaryEntryWithAliases,
  Match,
} from "@/glossary/models";

import { openProjectDb, type ProjectDb } from "../dexie";
import {
  type AliasSide,
  type EntityType,
  type EntityMentionRow,
  type GenderTag,
  type GlossaryAliasRow,
  type GlossaryEntryRow,
  type GlossaryRevisionRow,
  type GlossaryStatusT,
} from "../schema";

export interface CreateGlossaryEntryInput {
  project_id: string;
  source_term: string | null;
  target_term: string;
  type?: EntityType;
  status?: GlossaryStatusT;
  gender?: GenderTag | null;
  notes?: string | null;
  first_seen_segment_id?: string | null;
  source_aliases?: readonly string[];
  target_aliases?: readonly string[];
  entry_id?: string;
  created_at?: number;
  updated_at?: number;
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

async function loadAliases(
  db: ProjectDb,
  entryId: string,
): Promise<{ source: string[]; target: string[] }> {
  const rows = await db.glossary_aliases.where("entry_id").equals(entryId).toArray();
  const source = rows.filter((r) => r.side === "source").map((r) => r.text).sort();
  const target = rows.filter((r) => r.side === "target").map((r) => r.text).sort();
  return { source, target };
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

export async function createGlossaryEntry(
  projectId: string,
  input: CreateGlossaryEntryInput,
): Promise<GlossaryEntryWithAliases> {
  const db = openProjectDb(projectId);
  const sourceKnown =
    input.source_known ?? (input.source_term !== null);
  if (input.source_term === null && sourceKnown) {
    throw new Error(
      "source_known=true requires a non-empty source_term; for target-only Lore Book entries pass source_known=false",
    );
  }
  const now = input.created_at ?? input.updated_at ?? nowMs();
  const entry: GlossaryEntryRow = {
    id: input.entry_id ?? newId(),
    project_id: input.project_id,
    type: input.type ?? "term",
    source_term: input.source_term,
    target_term: input.target_term,
    gender: input.gender ?? null,
    status: input.status ?? "proposed",
    notes: input.notes ?? null,
    first_seen_segment_id: input.first_seen_segment_id ?? null,
    created_at: now,
    updated_at: input.updated_at ?? now,
    source_known: sourceKnown,
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
  return rowToWith(entry, src, tgt);
}

export async function getGlossaryEntry(
  projectId: string,
  entryId: string,
): Promise<GlossaryEntryWithAliases | undefined> {
  const db = openProjectDb(projectId);
  const entry = await db.glossary_entries.get(entryId);
  if (!entry) return undefined;
  const aliases = await loadAliases(db, entryId);
  return rowToWith(entry, aliases.source, aliases.target);
}

export async function listGlossaryEntries(
  projectId: string,
  opts: { status?: GlossaryStatusT } = {},
): Promise<GlossaryEntryWithAliases[]> {
  const db = openProjectDb(projectId);
  let collection = db.glossary_entries
    .where("project_id")
    .equals(projectId);
  let entries = await collection.toArray();
  if (opts.status !== undefined) {
    entries = entries.filter((e) => e.status === opts.status);
  }
  entries.sort((a, b) => {
    const sa = a.source_term ?? "";
    const sb = b.source_term ?? "";
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  if (entries.length === 0) return [];
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

export async function findGlossaryEntryBySourceTerm(
  projectId: string,
  source_term: string,
  type?: EntityType,
): Promise<GlossaryEntryRow | undefined> {
  const db = openProjectDb(projectId);
  const matches = await db.glossary_entries
    .where("source_term")
    .equals(source_term)
    .toArray();
  return matches.find(
    (m) => m.project_id === projectId && (type === undefined || m.type === type),
  );
}

export interface UpdateGlossaryEntryInput {
  target_term?: string;
  status?: GlossaryStatusT;
  type?: EntityType;
  gender?: GenderTag | null;
  notes?: string | null;
  reason?: string | null;
}

export async function updateGlossaryEntry(
  projectId: string,
  entryId: string,
  patch: UpdateGlossaryEntryInput,
): Promise<GlossaryEntryRow> {
  const db = openProjectDb(projectId);
  let updated: GlossaryEntryRow | null = null;
  await db.transaction(
    "rw",
    db.glossary_entries,
    db.glossary_revisions,
    async () => {
      const existing = await db.glossary_entries.get(entryId);
      if (!existing) throw new Error(`glossary entry not found: ${entryId}`);
      const next: GlossaryEntryRow = { ...existing };
      let changed = false;
      let targetChanged = false;
      let statusChanged = false;
      if (patch.target_term !== undefined && patch.target_term !== existing.target_term) {
        next.target_term = patch.target_term;
        targetChanged = true;
        changed = true;
      }
      if (patch.status !== undefined && patch.status !== existing.status) {
        next.status = patch.status;
        statusChanged = true;
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
      if (targetChanged || statusChanged) {
        const rev: GlossaryRevisionRow = {
          id: newId(),
          entry_id: entryId,
          prev_target_term: existing.target_term,
          new_target_term: targetChanged ? next.target_term : existing.target_term,
          reason:
            patch.reason ??
            (statusChanged && !targetChanged
              ? `status: ${existing.status} -> ${next.status}`
              : null),
          created_at: nowMs(),
        };
        await db.glossary_revisions.put(rev);
      }
      updated = next;
    },
  );
  if (!updated) throw new Error(`glossary entry not found: ${entryId}`);
  return updated;
}

export async function deleteGlossaryEntry(
  projectId: string,
  entryId: string,
): Promise<void> {
  const db = openProjectDb(projectId);
  await db.transaction(
    "rw",
    db.glossary_entries,
    db.glossary_aliases,
    db.glossary_revisions,
    db.entity_mentions,
    async () => {
      await db.glossary_entries.delete(entryId);
      await db.glossary_aliases.where("entry_id").equals(entryId).delete();
      await db.glossary_revisions.where("entry_id").equals(entryId).delete();
      await db.entity_mentions.where("entry_id").equals(entryId).delete();
    },
  );
}

/**
 * Replace all aliases for `entryId` with the given sets.
 *
 * De-duplicates within each side. The canonical term is *not* added
 * here — the matcher already includes it.
 */
export async function setAliases(
  projectId: string,
  entryId: string,
  opts: { source_aliases?: readonly string[]; target_aliases?: readonly string[] },
): Promise<void> {
  const db = openProjectDb(projectId);
  const src = dedupAliases(null, opts.source_aliases ?? []);
  const tgt = dedupAliases(null, opts.target_aliases ?? []);
  const payload: GlossaryAliasRow[] = [
    ...src.map<GlossaryAliasRow>((text) => ({
      id: newId(),
      entry_id: entryId,
      side: "source" as AliasSide,
      text,
    })),
    ...tgt.map<GlossaryAliasRow>((text) => ({
      id: newId(),
      entry_id: entryId,
      side: "target" as AliasSide,
      text,
    })),
  ];
  await db.transaction(
    "rw",
    db.glossary_aliases,
    async () => {
      await db.glossary_aliases.where("entry_id").equals(entryId).delete();
      if (payload.length) await db.glossary_aliases.bulkPut(payload);
    },
  );
}

export async function listAliases(
  projectId: string,
  entryId: string,
): Promise<GlossaryAliasRow[]> {
  const db = openProjectDb(projectId);
  const rows = await db.glossary_aliases.where("entry_id").equals(entryId).toArray();
  rows.sort((a, b) => {
    if (a.side !== b.side) return a.side < b.side ? -1 : 1;
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  });
  return rows;
}

export async function listGlossaryRevisions(
  projectId: string,
  entryId: string,
): Promise<GlossaryRevisionRow[]> {
  const db = openProjectDb(projectId);
  const rows = await db.glossary_revisions.where("entry_id").equals(entryId).toArray();
  rows.sort((a, b) => a.created_at - b.created_at);
  return rows;
}

/**
 * Replace `entity_mention` rows for `segmentId` with `mentions`.
 *
 * `mentions` is an iterable of `(entry_id, span_start, span_end)`
 * tuples; we de-duplicate within the call.
 */
export async function recordMentions(
  projectId: string,
  segmentId: string,
  mentions: ReadonlyArray<Match>,
): Promise<void> {
  const seen = new Set<string>();
  const payload: EntityMentionRow[] = [];
  for (const m of mentions) {
    const key = `${m.entry_id}|${m.start}|${m.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    payload.push({
      id: newId(),
      segment_id: segmentId,
      entry_id: m.entry_id,
      source_span_start: m.start,
      source_span_end: m.end,
    });
  }
  const db = openProjectDb(projectId);
  await db.transaction(
    "rw",
    db.entity_mentions,
    async () => {
      await db.entity_mentions.where("segment_id").equals(segmentId).delete();
      if (payload.length) await db.entity_mentions.bulkPut(payload);
    },
  );
}

export async function listMentions(
  projectId: string,
  opts: { segment_id?: string; entry_id?: string } = {},
): Promise<EntityMentionRow[]> {
  const db = openProjectDb(projectId);
  let rows: EntityMentionRow[];
  if (opts.segment_id !== undefined) {
    rows = await db.entity_mentions.where("segment_id").equals(opts.segment_id).toArray();
  } else if (opts.entry_id !== undefined) {
    rows = await db.entity_mentions.where("entry_id").equals(opts.entry_id).toArray();
  } else {
    rows = await db.entity_mentions.toArray();
  }
  if (opts.entry_id !== undefined) {
    rows = rows.filter((r) => r.entry_id === opts.entry_id);
  }
  return rows;
}

export interface MentionCounts {
  mentions: number;
  segments: number;
}

export async function countMentionsPerEntry(
  projectId: string,
): Promise<Record<string, MentionCounts>> {
  const db = openProjectDb(projectId);
  const all = await db.entity_mentions.toArray();
  const totals = new Map<string, { mentions: number; segments: Set<string> }>();
  for (const m of all) {
    const cur = totals.get(m.entry_id) ?? {
      mentions: 0,
      segments: new Set<string>(),
    };
    cur.mentions += 1;
    cur.segments.add(m.segment_id);
    totals.set(m.entry_id, cur);
  }
  const out: Record<string, MentionCounts> = {};
  for (const [eid, c] of totals) {
    out[eid] = { mentions: c.mentions, segments: c.segments.size };
  }
  return out;
}

export interface OccurrenceRow {
  mention_id: string;
  segment_id: string;
  segment_idx: number;
  chapter_id: string;
  chapter_spine_idx: number;
  chapter_title: string | null;
  source_text: string;
  target_text: string | null;
  source_span_start: number | null;
  source_span_end: number | null;
}

export async function listOccurrences(
  projectId: string,
  entryId: string,
): Promise<OccurrenceRow[]> {
  const db = openProjectDb(projectId);
  const mentions = await db.entity_mentions.where("entry_id").equals(entryId).toArray();
  if (!mentions.length) return [];
  const segIds = [...new Set(mentions.map((m) => m.segment_id))];
  const segments = await db.segments.where("id").anyOf(segIds).toArray();
  const segById = new Map(segments.map((s) => [s.id, s]));
  const chapterIds = [...new Set(segments.map((s) => s.chapter_id))];
  const chapters = await db.chapters.where("id").anyOf(chapterIds).toArray();
  const chById = new Map(chapters.map((c) => [c.id, c]));
  const out: OccurrenceRow[] = [];
  for (const m of mentions) {
    const seg = segById.get(m.segment_id);
    if (!seg) continue;
    const ch = chById.get(seg.chapter_id);
    if (!ch) continue;
    out.push({
      mention_id: m.id,
      segment_id: m.segment_id,
      segment_idx: seg.idx,
      chapter_id: seg.chapter_id,
      chapter_spine_idx: ch.spine_idx,
      chapter_title: ch.title,
      source_text: seg.source_text,
      target_text: seg.target_text,
      source_span_start: m.source_span_start,
      source_span_end: m.source_span_end,
    });
  }
  out.sort((a, b) => {
    if (a.chapter_spine_idx !== b.chapter_spine_idx) {
      return a.chapter_spine_idx - b.chapter_spine_idx;
    }
    if (a.segment_idx !== b.segment_idx) return a.segment_idx - b.segment_idx;
    return (a.source_span_start ?? 0) - (b.source_span_start ?? 0);
  });
  return out;
}

/** Return groups of entries sharing a non-empty source term (rank-sorted). */
export async function findDuplicateSourceTerms(
  projectId: string,
): Promise<GlossaryEntryWithAliases[][]> {
  const all = await listGlossaryEntries(projectId);
  const bySource = new Map<string, GlossaryEntryWithAliases[]>();
  for (const ent of all) {
    if (!ent.entry.source_term) continue;
    const arr = bySource.get(ent.entry.source_term) ?? [];
    arr.push(ent);
    bySource.set(ent.entry.source_term, arr);
  }
  const statusRank: Record<string, number> = {
    locked: 0,
    confirmed: 1,
    proposed: 2,
  };
  const out: GlossaryEntryWithAliases[][] = [];
  for (const group of bySource.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      const sa = statusRank[a.entry.status] ?? 99;
      const sb = statusRank[b.entry.status] ?? 99;
      if (sa !== sb) return sa - sb;
      const ta = a.entry.type !== "term" ? 0 : 1;
      const tb = b.entry.type !== "term" ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return a.entry.created_at - b.entry.created_at;
    });
    out.push(group);
  }
  return out;
}

/**
 * Fold `loserIds` into `winnerId` and delete the losers.
 *
 * Mirrors `merge_glossary_entries` — adds loser source/target as
 * aliases on the winner (deduped against winner's canonical + existing
 * aliases), re-points entity_mention rows, and records a revision.
 */
export async function mergeGlossaryEntries(
  projectId: string,
  opts: { winner_id: string; loser_ids: readonly string[]; reason?: string | null },
): Promise<number> {
  const { winner_id, loser_ids } = opts;
  if (!loser_ids.length) return 0;
  const db = openProjectDb(projectId);
  let added = 0;
  await db.transaction(
    "rw",
    db.glossary_entries,
    db.glossary_aliases,
    db.glossary_revisions,
    db.entity_mentions,
    async () => {
      const winner = await db.glossary_entries.get(winner_id);
      if (!winner) throw new Error(`glossary entry not found: ${winner_id}`);
      const winnerSource = winner.source_term;
      const winnerTarget = winner.target_term;
      const winnerAliases = await db.glossary_aliases
        .where("entry_id")
        .equals(winner_id)
        .toArray();
      const existingSrc = new Set(
        winnerAliases.filter((a) => a.side === "source").map((a) => a.text),
      );
      const existingTgt = new Set(
        winnerAliases.filter((a) => a.side === "target").map((a) => a.text),
      );

      for (const lid of loser_ids) {
        if (lid === winner_id) continue;
        const loser = await db.glossary_entries.get(lid);
        if (!loser) continue;
        const newAliases: GlossaryAliasRow[] = [];
        if (
          loser.source_term &&
          loser.source_term !== winnerSource &&
          !existingSrc.has(loser.source_term)
        ) {
          existingSrc.add(loser.source_term);
          newAliases.push({
            id: newId(),
            entry_id: winner_id,
            side: "source",
            text: loser.source_term,
          });
        }
        if (
          loser.target_term &&
          loser.target_term !== winnerTarget &&
          !existingTgt.has(loser.target_term)
        ) {
          existingTgt.add(loser.target_term);
          newAliases.push({
            id: newId(),
            entry_id: winner_id,
            side: "target",
            text: loser.target_term,
          });
        }
        const loserAliases = await db.glossary_aliases
          .where("entry_id")
          .equals(lid)
          .toArray();
        for (const al of loserAliases) {
          if (al.side === "source") {
            if (existingSrc.has(al.text) || al.text === winnerSource) continue;
            existingSrc.add(al.text);
          } else {
            if (existingTgt.has(al.text) || al.text === winnerTarget) continue;
            existingTgt.add(al.text);
          }
          newAliases.push({
            id: newId(),
            entry_id: winner_id,
            side: al.side,
            text: al.text,
          });
        }
        if (newAliases.length) await db.glossary_aliases.bulkPut(newAliases);
        // Re-point entity mentions to the winner.
        const loserMentions = await db.entity_mentions
          .where("entry_id")
          .equals(lid)
          .toArray();
        for (const m of loserMentions) {
          await db.entity_mentions.put({ ...m, entry_id: winner_id });
        }
        await db.glossary_aliases.where("entry_id").equals(lid).delete();
        await db.glossary_revisions.where("entry_id").equals(lid).delete();
        await db.glossary_entries.delete(lid);
        added += 1;
      }

      if (added) {
        const now = nowMs();
        await db.glossary_revisions.put({
          id: newId(),
          entry_id: winner_id,
          prev_target_term: winnerTarget,
          new_target_term: winnerTarget,
          reason: opts.reason ?? "merge",
          created_at: now,
        });
        await db.glossary_entries.put({ ...winner, updated_at: now });
      }
    },
  );
  return added;
}

export type {
  GlossaryEntryRow,
  GlossaryAliasRow,
  GlossaryRevisionRow,
  EntityMentionRow,
};
