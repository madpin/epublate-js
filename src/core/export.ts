/**
 * Build a translated ePub blob from a project's database state.
 *
 * Mirrors the Python `epublate` "save" path:
 *   1. Re-load the original ePub bytes from the per-project DB into a
 *      fresh `Book` AST.
 *   2. For every chapter, fetch its segments. If we have a translated
 *      string we substitute it; otherwise we fall back to the source
 *      text. This guarantees that every block-host slot has *some*
 *      content even on a partial run.
 *   3. Run `reassembleChapter` per chapter so the placeholders are
 *      restored and inline tags re-stitched.
 *   4. Hand the mutated `Book` to `buildEpubBlob` and return the blob.
 *
 * The OPF is updated to advertise the target language so e-readers
 * pick the correct hyphenation and spell-checking dictionaries.
 */

import { openProjectDb } from "@/db/dexie";
import { libraryDb } from "@/db/library";
import { rowToSegment } from "@/db/repo/segments";
import { loadEpub } from "@/formats/epub/loader";
import { reassembleChapter } from "@/formats/epub/reassembly";
import {
  type Book,
  type Segment as EpubSegment,
} from "@/formats/epub/types";
import { buildEpubBlob, buildEpubBytes } from "@/formats/epub/writer";
import { SegmentStatus, type SegmentRow } from "@/db/schema";

async function buildTranslatedBook(project_id: string): Promise<Book> {
  const db = openProjectDb(project_id);
  const project = await db.projects.get(project_id);
  if (!project) {
    throw new Error(`Project ${project_id} not found`);
  }

  const blob_row = await db.source_blobs.get("original");
  if (!blob_row) {
    throw new Error("Original ePub blob is missing for this project.");
  }

  // Some IDB backends (fake-indexeddb in particular) hand the bytes
  // back as a typed-array view rather than a fresh ArrayBuffer; copy
  // into a new Uint8Array so JSZip is happy in both real browsers
  // and the test environment.
  const raw_bytes = blob_row.bytes;
  const bytes = new Uint8Array(
    raw_bytes instanceof ArrayBuffer
      ? raw_bytes.slice(0)
      : (raw_bytes as ArrayBufferLike),
  );

  const book: Book = await loadEpub(bytes, {
    filename: blob_row.filename,
  });

  const chapter_rows = await db.chapters
    .where("project_id")
    .equals(project_id)
    .toArray();
  chapter_rows.sort((a, b) => a.spine_idx - b.spine_idx);

  for (const ch of book.chapters) {
    const row = chapter_rows.find((r) => r.href === ch.href);
    if (!row) continue;
    const segs = await db.segments
      .where("chapter_id")
      .equals(row.id)
      .toArray();
    if (segs.length === 0) continue;
    segs.sort((a, b) => a.idx - b.idx);
    const translated_segments: EpubSegment[] = segs.map((s) =>
      rowToTranslatedSegment(s),
    );
    reassembleChapter(ch, translated_segments);
  }

  return book;
}

export async function buildTranslatedEpub(
  project_id: string,
): Promise<Blob> {
  const db = openProjectDb(project_id);
  const project = await db.projects.get(project_id);
  if (!project) throw new Error(`Project ${project_id} not found`);
  const book = await buildTranslatedBook(project_id);
  return buildEpubBlob(book, {
    target_lang: project.target_lang,
    provenance: "epublate-js",
  });
}

/**
 * Bytes-returning variant — primarily for tests on environments where
 * `Blob#arrayBuffer()` isn't available (jsdom).
 */
export async function buildTranslatedEpubBytes(
  project_id: string,
): Promise<Uint8Array> {
  const db = openProjectDb(project_id);
  const project = await db.projects.get(project_id);
  if (!project) throw new Error(`Project ${project_id} not found`);
  const book = await buildTranslatedBook(project_id);
  return buildEpubBytes(book, {
    target_lang: project.target_lang,
    provenance: "epublate-js",
  });
}

function rowToTranslatedSegment(row: SegmentRow): EpubSegment {
  // Prefer the translated text; gracefully fall back to source on any
  // segment that hasn't been touched yet so the export still produces
  // a consistent ePub for partial runs.
  const seg = rowToSegment(row);
  const has_translation =
    row.status !== SegmentStatus.PENDING &&
    typeof row.target_text === "string" &&
    row.target_text.length > 0;
  const target_text = has_translation
    ? (row.target_text ?? row.source_text)
    : row.source_text;
  return {
    ...seg,
    target_text,
  };
}

/**
 * Compute the curator-friendly filename for the translated ePub.
 *
 * Mirrors Python's `<basename>.<target_lang>.epub` convention.
 */
export async function suggestTranslatedFilename(
  project_id: string,
): Promise<string> {
  const lib = await libraryDb().projects.get(project_id);
  const detail_db = openProjectDb(project_id);
  const detail = await detail_db.projects.get(project_id);
  const lang = detail?.target_lang ?? "translated";
  const stem = (lib?.source_filename ?? "epublate")
    .replace(/\.epub$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${stem}.${lang}.epub`;
}
