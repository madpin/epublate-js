/**
 * Per-project bundle export + import.
 *
 * The bundle is a single zip containing:
 *
 *   - `manifest.json`         — schema version + provenance.
 *   - `original.epub`         — verbatim source the curator uploaded.
 *   - `project.json`          — single project row (per-project DB).
 *   - `chapters.jsonl`        — JSON-Lines for streaming-friendly bodies.
 *   - `segments.jsonl`        — ditto, includes target text for resumability.
 *   - `glossary.jsonl`,
 *     `glossary_aliases.jsonl`,
 *     `glossary_revisions.jsonl`,
 *     `entity_mentions.jsonl`,
 *     `llm_calls.jsonl`,
 *     `events.jsonl`,
 *     `intake_runs.jsonl`,
 *     `intake_run_entries.jsonl`,
 *     `attached_lore.jsonl`.
 *   - **v2 only:** `segment_embeddings.jsonl` and
 *     `glossary_entry_embeddings.jsonl` — embedding vectors for
 *     `scope = "segment"` and `scope = "glossary_entry"` rows
 *     respectively, with `vector` re-encoded as base64. Older
 *     bundles omit these files; importers must treat them as
 *     optional.
 *
 * The bundle is intentionally self-contained: re-importing it on a
 * fresh device must reconstitute the entire per-project state byte-
 * exactly, with the original ePub preserved so re-translation /
 * re-export remains lossless. Lore Books are referenced by id in the
 * `attached_lore` rows; bundling the Lore Books themselves is the
 * curator's choice via the per-Lore-Book bundle export.
 */

import JSZip from "jszip";

import { libraryDb } from "@/db/library";
import { openProjectDb } from "@/db/dexie";
import { loadEpub } from "@/formats/epub/loader";
import { newId } from "@/lib/id";
import { nowMs } from "@/lib/time";
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
  type LibraryProjectRow,
  type LlmCallRow,
  type LoreMetaRow,
  type LoreSourceRow,
  type ProjectRow,
  type SegmentRow,
} from "@/db/schema";

/**
 * v1 → v2 bumped for the Phase 1 embedding tables. v2 bundles add
 * two new JSONL streams; v1 bundles continue to import cleanly via
 * the optional-file path in `importProjectBundle`.
 */
const SCHEMA_VERSION = 2;

interface BundleManifest {
  schema_version: number;
  exported_at: number;
  project_id: string;
  app: "epublate-js";
  app_version: string;
}

function jsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

/**
 * Re-encode an embedding row's `vector` (a `Uint8Array` view of the
 * underlying `Float32Array` byte buffer) as base64 so it survives a
 * `JSON.stringify` round-trip. Mirrors `decodeEmbeddingForImport`.
 */
function encodeEmbeddingForExport(row: EmbeddingRow): {
  id: string;
  scope: EmbeddingRow["scope"];
  ref_id: string;
  model: string;
  dim: number;
  vector_b64: string;
  created_at: number;
} {
  const u8 = row.vector;
  let s = "";
  for (let i = 0; i < u8.length; i++) {
    s += String.fromCharCode(u8[i]!);
  }
  const vector_b64 = (
    typeof btoa === "function"
      ? btoa(s)
      : Buffer.from(u8).toString("base64")
  );
  return {
    id: row.id,
    scope: row.scope,
    ref_id: row.ref_id,
    model: row.model,
    dim: row.dim,
    vector_b64,
    created_at: row.created_at,
  };
}

/**
 * Inverse of `encodeEmbeddingForExport`. Returns a fresh
 * `EmbeddingRow` ready for `db.embeddings.put`.
 */
function decodeEmbeddingForImport(
  raw: {
    id: string;
    scope: EmbeddingRow["scope"];
    ref_id: string;
    model: string;
    dim: number;
    vector_b64: string;
    created_at: number;
  },
): EmbeddingRow {
  const bin =
    typeof atob === "function"
      ? atob(raw.vector_b64)
      : Buffer.from(raw.vector_b64, "base64").toString("binary");
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return {
    id: raw.id,
    scope: raw.scope,
    ref_id: raw.ref_id,
    model: raw.model,
    dim: raw.dim,
    vector: u8,
    created_at: raw.created_at,
  };
}

export async function exportProjectBundle(
  project_id: string,
): Promise<{ blob: Blob; filename: string }> {
  const lib = await libraryDb().projects.get(project_id);
  if (!lib) throw new Error(`Project ${project_id} not found in library.`);

  const db = openProjectDb(project_id);
  const project = await db.projects.get(project_id);
  if (!project) {
    throw new Error(`Project ${project_id} not found in per-project DB.`);
  }

  const blob_row = await db.source_blobs.get("original");
  if (!blob_row) {
    throw new Error("Original ePub missing — cannot build a faithful bundle.");
  }

  const [
    chapters,
    segments,
    glossary,
    aliases,
    revisions,
    mentions,
    llm_calls,
    events,
    intake_runs,
    intake_run_entries,
    attached_lore,
    lore_meta,
    lore_sources,
    embeddings,
  ] = await Promise.all([
    db.chapters.toArray(),
    db.segments.toArray(),
    db.glossary_entries.toArray(),
    db.glossary_aliases.toArray(),
    db.glossary_revisions.toArray(),
    db.entity_mentions.toArray(),
    db.llm_calls.toArray(),
    db.events.toArray(),
    db.intake_runs.toArray(),
    db.intake_run_entries.toArray(),
    db.attached_lore.toArray(),
    db.lore_meta.toArray(),
    db.lore_sources.toArray(),
    db.embeddings.toArray(),
  ]);

  // Split by `scope` so importers on older schemas can still parse
  // the segment / glossary streams independently. Lore-Book scope
  // (`glossary_entry` originating from a separate Lore DB) doesn't
  // live in the project DB, so there's nothing to write here for it.
  const segment_embeddings = embeddings
    .filter((e) => e.scope === "segment")
    .map(encodeEmbeddingForExport);
  const glossary_entry_embeddings = embeddings
    .filter((e) => e.scope === "glossary_entry")
    .map(encodeEmbeddingForExport);

  const manifest: BundleManifest = {
    schema_version: SCHEMA_VERSION,
    exported_at: nowMs(),
    project_id,
    app: "epublate-js",
    app_version: "0.1.0",
  };

  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("project.json", JSON.stringify(project, null, 2));
  // Redact binary cover bytes from the exported library row — JSON
  // serialization would silently turn them into `{}`, which is just
  // noise for re-importers (we re-extract the cover on import from
  // the bundled `original.epub`).
  const lib_for_export = {
    ...lib,
    cover_image_bytes: null,
    cover_image_media_type: lib.cover_image_media_type ?? null,
  };
  zip.file("library_row.json", JSON.stringify(lib_for_export, null, 2));

  // Original ePub bytes — wrap in a fresh `Uint8Array` so JSZip is
  // happy in both real browsers and in `fake-indexeddb` test
  // environments (which sometimes hands back the bytes as a typed-
  // array view rather than a standalone ArrayBuffer).
  const raw = blob_row.bytes;
  const u8 = new Uint8Array(
    raw instanceof ArrayBuffer ? raw.slice(0) : (raw as ArrayBufferLike),
  );
  zip.file("original.epub", u8, { binary: true });

  // JSONL streams — one record per line; cheap to stream-parse.
  zip.file("chapters.jsonl", jsonl(chapters));
  zip.file("segments.jsonl", jsonl(segments));
  zip.file("glossary.jsonl", jsonl(glossary));
  zip.file("glossary_aliases.jsonl", jsonl(aliases));
  zip.file("glossary_revisions.jsonl", jsonl(revisions));
  zip.file("entity_mentions.jsonl", jsonl(mentions));
  zip.file("llm_calls.jsonl", jsonl(llm_calls));
  zip.file("events.jsonl", jsonl(events));
  zip.file("intake_runs.jsonl", jsonl(intake_runs));
  zip.file("intake_run_entries.jsonl", jsonl(intake_run_entries));
  zip.file("attached_lore.jsonl", jsonl(attached_lore));
  zip.file("lore_meta.jsonl", jsonl(lore_meta));
  zip.file("lore_sources.jsonl", jsonl(lore_sources));
  // v2 — embedding artifacts. We always emit the files (even when
  // empty) so importers can detect "this bundle was exported by a
  // v2-aware build" by checking the manifest version, not by file
  // presence.
  zip.file("segment_embeddings.jsonl", jsonl(segment_embeddings));
  zip.file(
    "glossary_entry_embeddings.jsonl",
    jsonl(glossary_entry_embeddings),
  );

  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/zip",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const safe_name = (lib.name || "project").replace(/[^A-Za-z0-9._-]+/g, "_");
  const filename = `${safe_name}.epublate-project.zip`;
  return { blob, filename };
}

/**
 * Re-hydrate a project from a previously-exported bundle.
 *
 * The new project gets a fresh id (so importing the same bundle twice
 * doesn't collide) and is filed in the library with whatever name
 * the curator passes via `name_override` — defaulting to the bundled
 * library row's `name`.
 */
export async function importProjectBundle(
  bytes: ArrayBuffer | Uint8Array,
  options: { name_override?: string } = {},
): Promise<{ project_id: string }> {
  const u8 =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(
          (bytes as Uint8Array).buffer,
          (bytes as Uint8Array).byteOffset,
          (bytes as Uint8Array).byteLength,
        );
  const zip = await JSZip.loadAsync(u8);

  const manifest_text = await zip.file("manifest.json")?.async("string");
  if (!manifest_text) {
    throw new Error("Bundle is missing manifest.json");
  }
  const manifest: BundleManifest = JSON.parse(manifest_text);
  if (manifest.schema_version > SCHEMA_VERSION) {
    throw new Error(
      `Bundle schema version ${manifest.schema_version} is newer than the app supports.`,
    );
  }

  const project_text = await zip.file("project.json")?.async("string");
  if (!project_text) throw new Error("Bundle is missing project.json");
  const old_project: ProjectRow = JSON.parse(project_text);

  const lib_text = await zip.file("library_row.json")?.async("string");
  const old_lib: LibraryProjectRow | null = lib_text
    ? JSON.parse(lib_text)
    : null;

  const original_bytes_blob = zip.file("original.epub");
  if (!original_bytes_blob) {
    throw new Error("Bundle is missing original.epub");
  }
  const original_bytes = await original_bytes_blob.async("uint8array");
  const original_buf = new ArrayBuffer(original_bytes.byteLength);
  new Uint8Array(original_buf).set(original_bytes);

  // Generate a fresh project id so re-importing the same bundle
  // creates a copy rather than colliding with the original.
  const new_project_id = newId();
  const created_at = nowMs();
  const new_project: ProjectRow = {
    ...old_project,
    id: new_project_id,
    created_at,
  };

  // Read ALL jsonl streams up front. Dexie won't tolerate awaiting on
  // non-Dexie promises (the JSZip `.async()` calls) while a
  // transaction is open — it will commit the txn before the bulkPut
  // calls run. So we drain everything to plain arrays first, then run
  // a single tight transaction below.
  const chapters_rows = withRewrite(
    await readJsonl<ChapterRow>(zip, "chapters.jsonl"),
    { project_id: new_project_id },
  );
  const segments_rows = await readJsonl<SegmentRow>(zip, "segments.jsonl");
  const glossary_rows = withRewrite(
    await readJsonl<GlossaryEntryRow>(zip, "glossary.jsonl"),
    { project_id: new_project_id },
  );
  const glossary_aliases_rows = await readJsonl<GlossaryAliasRow>(
    zip,
    "glossary_aliases.jsonl",
  );
  const glossary_revisions_rows = await readJsonl<GlossaryRevisionRow>(
    zip,
    "glossary_revisions.jsonl",
  );
  const entity_mention_rows = await readJsonl<EntityMentionRow>(
    zip,
    "entity_mentions.jsonl",
  );
  const llm_call_rows = withRewrite(
    await readJsonl<LlmCallRow>(zip, "llm_calls.jsonl"),
    { project_id: new_project_id },
  );
  const event_rows = await readJsonl<EventRow>(zip, "events.jsonl");
  const intake_run_rows = withRewrite(
    await readJsonl<IntakeRunRow>(zip, "intake_runs.jsonl"),
    { project_id: new_project_id },
  );
  const intake_run_entry_rows = await readJsonl<IntakeRunEntryRow>(
    zip,
    "intake_run_entries.jsonl",
  );
  const attached_lore_rows = withRewrite(
    await readJsonl<AttachedLoreRow>(zip, "attached_lore.jsonl"),
    { project_id: new_project_id },
  );
  const lore_meta_rows = await readJsonl<LoreMetaRow>(zip, "lore_meta.jsonl");
  const lore_source_rows = withRewrite(
    await readJsonl<LoreSourceRow>(zip, "lore_sources.jsonl"),
    { project_id: new_project_id },
  );

  // Embeddings are optional — v1 bundles don't include them, and v2
  // bundles for projects with `embedding_provider = "none"` will
  // emit empty files. We do not rewrite the `id` because the
  // `[scope+ref_id+model]` index is the actual uniqueness contract;
  // collisions can't happen across two imported bundles since the
  // `ref_id` either points at a freshly imported segment / entry or
  // gets dropped silently when the DB enforces foreign-key-shape
  // constraints.
  const raw_segment_embeddings = await readJsonl<{
    id: string;
    scope: EmbeddingRow["scope"];
    ref_id: string;
    model: string;
    dim: number;
    vector_b64: string;
    created_at: number;
  }>(zip, "segment_embeddings.jsonl");
  const raw_glossary_entry_embeddings = await readJsonl<{
    id: string;
    scope: EmbeddingRow["scope"];
    ref_id: string;
    model: string;
    dim: number;
    vector_b64: string;
    created_at: number;
  }>(zip, "glossary_entry_embeddings.jsonl");
  const embedding_rows: EmbeddingRow[] = [
    ...raw_segment_embeddings.map(decodeEmbeddingForImport),
    ...raw_glossary_entry_embeddings.map(decodeEmbeddingForImport),
  ];
  const stripped_events = event_rows.map((row) => {
    const { id: _id, ...rest } = row;
    return { ...rest, project_id: new_project_id };
  });

  const db = openProjectDb(new_project_id);
  await db.transaction(
    "rw",
    [
      db.projects,
      db.chapters,
      db.segments,
      db.glossary_entries,
      db.glossary_aliases,
      db.glossary_revisions,
      db.entity_mentions,
      db.llm_calls,
      db.events,
      db.intake_runs,
      db.intake_run_entries,
      db.attached_lore,
      db.lore_meta,
      db.lore_sources,
      db.source_blobs,
      db.embeddings,
    ],
    async () => {
      await db.projects.put(new_project);
      await db.source_blobs.put({
        key: "original",
        filename: old_lib?.source_filename ?? "imported.epub",
        mime: "application/epub+zip",
        size_bytes: original_bytes.byteLength,
        bytes: original_buf,
      });
      if (chapters_rows.length > 0) await db.chapters.bulkPut(chapters_rows);
      if (segments_rows.length > 0) await db.segments.bulkPut(segments_rows);
      if (glossary_rows.length > 0) await db.glossary_entries.bulkPut(glossary_rows);
      if (glossary_aliases_rows.length > 0)
        await db.glossary_aliases.bulkPut(glossary_aliases_rows);
      if (glossary_revisions_rows.length > 0)
        await db.glossary_revisions.bulkPut(glossary_revisions_rows);
      if (entity_mention_rows.length > 0)
        await db.entity_mentions.bulkPut(entity_mention_rows);
      if (llm_call_rows.length > 0) await db.llm_calls.bulkPut(llm_call_rows);
      if (stripped_events.length > 0) await db.events.bulkAdd(stripped_events);
      if (intake_run_rows.length > 0) await db.intake_runs.bulkPut(intake_run_rows);
      if (intake_run_entry_rows.length > 0)
        await db.intake_run_entries.bulkPut(intake_run_entry_rows);
      if (attached_lore_rows.length > 0)
        await db.attached_lore.bulkPut(attached_lore_rows);
      if (lore_meta_rows.length > 0) await db.lore_meta.bulkPut(lore_meta_rows);
      if (lore_source_rows.length > 0) await db.lore_sources.bulkPut(lore_source_rows);
      if (embedding_rows.length > 0) await db.embeddings.bulkPut(embedding_rows);
    },
  );

  // Library row. Re-extract the cover image from the original ePub
  // bytes — the bundle's library_row.json went through JSON.stringify,
  // which collapses ArrayBuffers to {}, so we can't trust the cover
  // fields from `old_lib`.
  const lib_name = options.name_override ?? old_lib?.name ?? old_project.name;
  let cover_image_bytes: ArrayBuffer | null = null;
  let cover_image_media_type: string | null = null;
  try {
    const re_book = await loadEpub(original_buf);
    if (re_book.cover) {
      const view = re_book.cover.bytes;
      const cb = new ArrayBuffer(view.byteLength);
      new Uint8Array(cb).set(view);
      cover_image_bytes = cb;
      cover_image_media_type = re_book.cover.media_type;
    }
  } catch {
    // The bundle's ePub was loadable when it was first imported, so
    // failing here is unusual — but we can ship without a thumbnail.
  }
  const new_lib: LibraryProjectRow = {
    id: new_project_id,
    name: lib_name,
    source_lang: new_project.source_lang,
    target_lang: new_project.target_lang,
    source_filename: old_lib?.source_filename ?? "imported.epub",
    source_size_bytes: original_bytes.byteLength,
    opened_at: created_at,
    created_at,
    progress_translated: old_lib?.progress_translated ?? 0,
    progress_total: old_lib?.progress_total ?? 0,
    style_profile: new_project.style_profile,
    cover_image_bytes,
    cover_image_media_type,
  };
  await libraryDb().projects.put(new_lib);

  return { project_id: new_project_id };
}

async function readJsonl<T>(
  zip: JSZip,
  filename: string,
): Promise<T[]> {
  const file = zip.file(filename);
  if (!file) return [];
  const text = await file.async("string");
  if (!text.trim()) return [];
  return text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function withRewrite<T>(rows: T[], rewrite: Partial<T>): T[] {
  return rows.map((row) => ({ ...row, ...rewrite }));
}
