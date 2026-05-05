/**
 * Per-project / per-Lore-Book Dexie database wrappers.
 *
 * Each project gets its own Dexie database (named
 * `epublate-project-<id>`) so deleting a project is a single
 * `Dexie.delete(name)` call and the IDB inspector shows one DB per
 * project — equivalent to the original tool's one-`.epublate`-per-project
 * SQLite layout. The schema is the same for both project and Lore Book
 * DBs; the only practical difference is which tables actually carry
 * rows (a Lore Book never has chapters/segments).
 *
 * The exported helpers `openProjectDb` / `openLoreDb` cache opened
 * Dexie handles by id so the rest of the app can call them as if they
 * were synchronous lookups.
 */

import Dexie, { type Table } from "dexie";

import { loreDbName, projectDbName } from "./library";
import {
  type AttachedLoreRow,
  type ChapterRow,
  type EmbeddingRow,
  type EntityMentionRow,
  type EventRow,
  type GlossaryAliasRow,
  type GlossaryEntryRow,
  type GlossaryRevisionRow,
  type IntakeRunEntryRow,
  type IntakeRunRow,
  type LlmCallRow,
  type LoreMetaRow,
  type LoreSourceRow,
  type ProjectRow,
  type SegmentRow,
} from "./schema";

/**
 * Stored alongside per-project tables so `original.epub` survives reloads.
 *
 * We store the bytes as `ArrayBuffer` rather than `Blob` because IDB's
 * structured-clone path serializes ArrayBuffers verbatim everywhere
 * (real browsers and the `fake-indexeddb` test backend). Callers that
 * need a `Blob` wrap with `new Blob([buf], { type: "..." })`, which is
 * a zero-copy view in real browsers.
 */
export interface SourceBlobRow {
  /** Always `"original"` in v1 — leaves room for future variants. */
  key: string;
  filename: string;
  mime: string;
  size_bytes: number;
  bytes: ArrayBuffer;
}

export class ProjectDb extends Dexie {
  projects!: Table<ProjectRow, string>;
  chapters!: Table<ChapterRow, string>;
  segments!: Table<SegmentRow, string>;
  glossary_entries!: Table<GlossaryEntryRow, string>;
  glossary_aliases!: Table<GlossaryAliasRow, string>;
  glossary_revisions!: Table<GlossaryRevisionRow, string>;
  entity_mentions!: Table<EntityMentionRow, string>;
  llm_calls!: Table<LlmCallRow, string>;
  events!: Table<EventRow, number>;
  embeddings!: Table<EmbeddingRow, string>;
  lore_meta!: Table<LoreMetaRow, string>;
  lore_sources!: Table<LoreSourceRow, string>;
  attached_lore!: Table<AttachedLoreRow, string>;
  intake_runs!: Table<IntakeRunRow, string>;
  intake_run_entries!: Table<IntakeRunEntryRow, [string, string]>;
  source_blobs!: Table<SourceBlobRow, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      // Each store's first column is the primary key. Compound keys are
      // declared as "[a+b]" inside the index spec; the rest are
      // single-column indices that the rest of the codebase queries by.
      projects: "id, name, kind, created_at",
      chapters: "id, project_id, [project_id+spine_idx], spine_idx, status",
      segments:
        "id, chapter_id, [chapter_id+idx], status, source_hash",
      glossary_entries:
        "id, project_id, status, type, source_term, target_term, updated_at",
      glossary_aliases:
        "id, entry_id, [entry_id+side+text], side, text",
      glossary_revisions: "id, entry_id, created_at",
      entity_mentions: "id, segment_id, entry_id, [segment_id+entry_id]",
      llm_calls:
        "id, project_id, segment_id, purpose, [project_id+cache_key], cache_key, created_at",
      events: "++id, project_id, ts, kind",
      embeddings: "id, scope, ref_id, [scope+ref_id+model]",
      lore_meta: "project_id, schema_version",
      lore_sources: "id, project_id, kind, status, ingested_at",
      attached_lore:
        "id, project_id, [project_id+lore_path], lore_path, mode, priority",
      intake_runs:
        "id, project_id, kind, chapter_id, status, started_at, finished_at",
      intake_run_entries: "[intake_run_id+entry_id], intake_run_id, entry_id",
      source_blobs: "key",
    });
  }
}

const projectCache = new Map<string, ProjectDb>();

export function openProjectDb(projectId: string): ProjectDb {
  const cached = projectCache.get(projectId);
  if (cached) return cached;
  const db = new ProjectDb(projectDbName(projectId));
  projectCache.set(projectId, db);
  return db;
}

export function closeProjectDb(projectId: string): void {
  const db = projectCache.get(projectId);
  if (db) {
    db.close();
    projectCache.delete(projectId);
  }
}

export async function deleteProjectDb(projectId: string): Promise<void> {
  closeProjectDb(projectId);
  await Dexie.delete(projectDbName(projectId));
}

const loreCache = new Map<string, ProjectDb>();

export function openLoreDb(loreId: string): ProjectDb {
  const cached = loreCache.get(loreId);
  if (cached) return cached;
  const db = new ProjectDb(loreDbName(loreId));
  loreCache.set(loreId, db);
  return db;
}

export function closeLoreDb(loreId: string): void {
  const db = loreCache.get(loreId);
  if (db) {
    db.close();
    loreCache.delete(loreId);
  }
}

export async function deleteLoreDb(loreId: string): Promise<void> {
  closeLoreDb(loreId);
  await Dexie.delete(loreDbName(loreId));
}
