/**
 * Lore Book lifecycle service (mirrors `epublate.lore.lore.LoreBook`).
 *
 * A Lore Book lives in its own Dexie database
 * (`epublate-lore-<id>`) so deleting one is a single
 * `Dexie.delete(name)` call. The schema reuses the same `ProjectDb`
 * shape that translation projects use; the only differences are:
 *
 *   - the singleton row in `projects` has `kind="lore"` so the same
 *     glossary repo helpers work unmodified;
 *   - the `lore_meta` row carries Lore-Book-only fields (description,
 *     default proposal kind);
 *   - the `chapters` / `segments` tables stay empty.
 *
 * The library row (`epublate-library.loreBooks`) is the
 * browser-friendly equivalent of `~/.config/epublate/lore/`: a flat,
 * persisted list the LoreBooks landing screen renders without
 * opening any per-Lore-Book DB.
 */

import { newId } from "@/lib/id";
import { nowMs } from "@/lib/time";

import { deleteLoreDb, openLoreDb } from "@/db/dexie";
import {
  removeLibraryLoreBook,
  touchLibraryLoreBook,
  upsertLibraryLoreBook,
} from "@/db/library";
import {
  type LibraryLoreBookRow,
  type LoreMetaRow,
  type LoreSourceKindT,
  type LoreSourceRow,
  type LoreSourceStatusT,
  type ProjectRow,
  LoreSourceKind,
  ProjectKind,
} from "@/db/schema";

export interface CreateLoreBookInput {
  name: string;
  source_lang: string;
  target_lang: string;
  description?: string | null;
  default_proposal_kind?: LoreSourceKindT;
}

export interface LoreBookHandle {
  id: string;
  name: string;
  source_lang: string;
  target_lang: string;
  description: string | null;
  default_proposal_kind: LoreSourceKindT;
  created_at: number;
}

/**
 * Initialize a fresh Lore Book in its own Dexie DB.
 *
 * Writes:
 *   - one `projects` row (`kind="lore"`) so the same glossary repo
 *     helpers work without changes;
 *   - one `lore_meta` row;
 *   - one `events` row (`lore.created`) for the audit log;
 *   - one library row so the Lore Books landing screen lists it.
 */
export async function createLoreBook(
  input: CreateLoreBookInput,
): Promise<LoreBookHandle> {
  const id = newId();
  const created_at = nowMs();
  const description = input.description ?? null;
  const default_proposal_kind =
    input.default_proposal_kind ?? LoreSourceKind.TARGET;

  const project_row: ProjectRow = {
    id,
    name: input.name,
    source_lang: input.source_lang,
    target_lang: input.target_lang,
    source_path: "",
    style_guide: null,
    style_profile: null,
    budget_usd: null,
    llm_overrides: null,
    created_at,
    kind: ProjectKind.LORE,
    context_max_segments: 0,
    context_max_chars: 0,
  };
  const meta_row: LoreMetaRow = {
    project_id: id,
    description,
    schema_version: 1,
    default_proposal_kind,
    created_at,
    updated_at: created_at,
  };

  const db = openLoreDb(id);
  await db.transaction(
    "rw",
    db.projects,
    db.lore_meta,
    db.events,
    async () => {
      await db.projects.put(project_row);
      await db.lore_meta.put(meta_row);
      await db.events.add({
        project_id: id,
        ts: created_at,
        kind: "lore.created",
        payload_json: JSON.stringify({
          name: input.name,
          source_lang: input.source_lang,
          target_lang: input.target_lang,
          default_proposal_kind,
        }),
      });
    },
  );

  const library_row: LibraryLoreBookRow = {
    id,
    name: input.name,
    source_lang: input.source_lang,
    target_lang: input.target_lang,
    description,
    default_proposal_kind,
    created_at,
    opened_at: created_at,
    entries_total: 0,
    entries_locked: 0,
  };
  await upsertLibraryLoreBook(library_row);

  return {
    id,
    name: input.name,
    source_lang: input.source_lang,
    target_lang: input.target_lang,
    description,
    default_proposal_kind,
    created_at,
  };
}

/** Re-open a Lore Book by id; updates `opened_at` on the library row. */
export async function openLoreBook(id: string): Promise<LoreBookHandle> {
  const db = openLoreDb(id);
  const project = await db.projects.get(id);
  if (!project) throw new Error(`lore book not found: ${id}`);
  const meta = await db.lore_meta.get(id);
  await touchLibraryLoreBook(id);
  return {
    id,
    name: project.name,
    source_lang: project.source_lang,
    target_lang: project.target_lang,
    description: meta?.description ?? null,
    default_proposal_kind:
      meta?.default_proposal_kind ?? LoreSourceKind.TARGET,
    created_at: project.created_at,
  };
}

export async function deleteLoreBook(id: string): Promise<void> {
  await deleteLoreDb(id);
  await removeLibraryLoreBook(id);
}

export interface UpdateLoreMetaInput {
  description?: string | null;
  default_proposal_kind?: LoreSourceKindT;
  name?: string;
}

/**
 * Patch the Lore Book's name / description / default proposal kind.
 *
 * The library row is updated in lockstep with the per-Lore-Book row
 * so the Lore Books landing screen renders without opening every
 * Lore Book DB.
 */
export async function updateLoreMeta(
  id: string,
  patch: UpdateLoreMetaInput,
): Promise<LoreBookHandle> {
  const db = openLoreDb(id);
  const project = await db.projects.get(id);
  if (!project) throw new Error(`lore book not found: ${id}`);
  const now = nowMs();
  await db.transaction("rw", db.projects, db.lore_meta, db.events, async () => {
    if (patch.name && patch.name !== project.name) {
      await db.projects.update(id, { name: patch.name });
    }
    const meta_patch: Partial<LoreMetaRow> = { updated_at: now };
    if (patch.description !== undefined) {
      meta_patch.description = patch.description;
    }
    if (patch.default_proposal_kind !== undefined) {
      meta_patch.default_proposal_kind = patch.default_proposal_kind;
    }
    if (Object.keys(meta_patch).length > 1) {
      const existing = await db.lore_meta.get(id);
      if (!existing) {
        throw new Error(`lore_meta row missing for lore book ${id}`);
      }
      const next: LoreMetaRow = { ...existing, ...meta_patch };
      await db.lore_meta.put(next);
    }
    await db.events.add({
      project_id: id,
      ts: now,
      kind: "lore.meta_updated",
      payload_json: JSON.stringify(patch),
    });
  });

  // Mirror to the library row.
  const refreshed_project = await db.projects.get(id);
  const refreshed_meta = await db.lore_meta.get(id);
  if (refreshed_project) {
    await upsertLibraryLoreBook({
      id,
      name: refreshed_project.name,
      source_lang: refreshed_project.source_lang,
      target_lang: refreshed_project.target_lang,
      description: refreshed_meta?.description ?? null,
      default_proposal_kind:
        refreshed_meta?.default_proposal_kind ?? LoreSourceKind.TARGET,
      created_at: refreshed_project.created_at,
      opened_at: nowMs(),
      entries_total: 0,
      entries_locked: 0,
    });
  }

  return openLoreBook(id);
}

export interface RecordLoreSourceInput {
  lore_id: string;
  kind: LoreSourceKindT;
  epub_path: string;
  status?: LoreSourceStatusT;
  entries_added?: number;
  notes?: string | null;
}

/** Record an ingested ePub against a Lore Book (audit only). */
export async function recordLoreSource(
  input: RecordLoreSourceInput,
): Promise<LoreSourceRow> {
  const db = openLoreDb(input.lore_id);
  const row: LoreSourceRow = {
    id: newId(),
    project_id: input.lore_id,
    kind: input.kind,
    epub_path: input.epub_path,
    status: input.status ?? "ingested",
    entries_added: input.entries_added ?? 0,
    notes: input.notes ?? null,
    ingested_at: nowMs(),
  };
  await db.lore_sources.put(row);
  return row;
}

export async function listLoreSources(
  lore_id: string,
): Promise<LoreSourceRow[]> {
  const db = openLoreDb(lore_id);
  const rows = await db.lore_sources.where("project_id").equals(lore_id).toArray();
  rows.sort((a, b) => b.ingested_at - a.ingested_at);
  return rows;
}

/**
 * Recompute the cached `entries_total` / `entries_locked` numbers on
 * the library row so the LoreBooks landing screen surfaces them
 * without opening every Lore Book DB. Cheap enough to call after
 * every glossary mutation against the Lore Book DB.
 */
export async function refreshLoreLibraryCounts(lore_id: string): Promise<void> {
  const db = openLoreDb(lore_id);
  const all = await db.glossary_entries
    .where("project_id")
    .equals(lore_id)
    .toArray();
  const locked = all.filter((e) => e.status === "locked").length;
  await upsertLibraryLoreBook({
    id: lore_id,
    name: (await db.projects.get(lore_id))?.name ?? "(unnamed)",
    source_lang: (await db.projects.get(lore_id))?.source_lang ?? "en",
    target_lang: (await db.projects.get(lore_id))?.target_lang ?? "en",
    description:
      (await db.lore_meta.get(lore_id))?.description ?? null,
    default_proposal_kind:
      (await db.lore_meta.get(lore_id))?.default_proposal_kind ??
      LoreSourceKind.TARGET,
    created_at: (await db.projects.get(lore_id))?.created_at ?? Date.now(),
    opened_at: Date.now(),
    entries_total: all.length,
    entries_locked: locked,
  });
}
