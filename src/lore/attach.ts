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

import { listLoreEntries } from "./glossary";

export interface AttachLoreInput {
  project_id: string;
  lore_id: string;
  mode?: AttachedLoreModeT;
  /** Higher = wins on conflicts. Defaults to next-highest priority. */
  priority?: number;
}

/**
 * Attach a Lore Book to a project. Idempotent on
 * `(project_id, lore_id)` — if the row already exists, this updates
 * mode + priority instead of inserting a duplicate.
 */
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
 */
export async function resolveProjectGlossaryWithLore(
  project_id: string,
  project_entries: Awaited<
    ReturnType<typeof import("@/db/repo/glossary").listGlossaryEntries>
  >,
): Promise<typeof project_entries> {
  const attached = await listAttachedLore(project_id);
  if (attached.length === 0) return project_entries;
  const seen_source = new Set<string>();
  const seen_target_only = new Set<string>();
  const merged: typeof project_entries = [];

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

  for (const att of attached) {
    let lore_entries: typeof project_entries;
    try {
      lore_entries = await listLoreEntries(att.lore_path);
    } catch {
      continue;
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
