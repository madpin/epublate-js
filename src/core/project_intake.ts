/**
 * Project intake — load an ePub blob, segment every chapter, persist
 * chapters + segments into IndexedDB. Mirrors the body of
 * `epublate.core.project._intake_chapters`.
 *
 * The function is split out so callers can run it from the New
 * Project modal (after `createProject`), from a "Repair / re-segment"
 * action on the Dashboard (P6), or from the Web Worker batch pool
 * (P4) — same code path, no UI assumptions.
 */

import { newId } from "@/lib/id";
import { sha256Hex } from "@/lib/hash";

import {
  bulkInsertSegments,
  type SegmentInsert,
} from "@/db/repo/segments";
import { createChapter } from "@/db/repo/chapters";
import { appendEvent } from "@/db/repo/projects";
import { libraryDb } from "@/db/library";

import { EpubAdapter } from "@/formats/epub";

export interface IntakeResult {
  chapters: number;
  segments: number;
  duration_ms: number;
  cover_extracted: boolean;
  /**
   * Number of segments embedded by the optional Phase 3 background
   * pass. `null` means the pass was not run (no embedding provider
   * configured / disabled). Phase 3.
   */
  embedded_segments: number | null;
}

/**
 * Parse `epub_bytes`, segment every chapter, and persist results.
 *
 * Idempotency: this function is *not* idempotent on its own — it
 * always inserts fresh rows. The project-creation flow runs it
 * exactly once at intake time. P6's repair flow is the equivalent of
 * the Python `Project.refresh_chapter_titles_from_epub` /
 * `re_segment_book`, and lives in a separate module.
 */
export async function runProjectIntake(input: {
  project_id: string;
  source_lang: string;
  target_lang: string;
  epub_bytes: ArrayBuffer | Uint8Array;
  source_filename?: string;
  /** Token cap per segment; long blocks split at sentence boundaries. */
  max_tokens?: number;
  /**
   * When set, runs `runEmbeddingPass` immediately after segmentation
   * so every newly-imported segment is embedded before the curator
   * starts translating. Best-effort: failures fall back to embedding
   * lazily during translation. Phase 3.
   *
   * The caller is responsible for resolving the active provider via
   * `buildEmbeddingProvider` (Settings + project overrides) and
   * passing it through here. Skipping this option preserves the
   * legacy, fully-offline intake.
   */
  embedding_pass?: {
    /** Active provider built from Settings + overrides. */
    provider: import("@/llm/embeddings/base").EmbeddingProvider;
    /** Override per-batch size for tests. */
    batch_size_override?: number | null;
    /** Optional progress callback for the Intake Runs screen. */
    on_progress?: (info: import("@/core/embedding_pass").EmbeddingPassProgress) => void;
    /** Cancellation hook plumbed through to the provider. */
    signal?: AbortSignal;
  } | null;
}): Promise<IntakeResult> {
  const start = Date.now();
  const adapter = new EpubAdapter();
  const book = await adapter.load(input.epub_bytes, {
    filename: input.source_filename,
  });

  const all_segments: SegmentInsert[] = [];
  let chapter_count = 0;

  for (const chapter_doc of adapter.iterChapters(book)) {
    const chapter = await createChapter({
      project_id: input.project_id,
      spine_idx: chapter_doc.spine_idx,
      href: chapter_doc.href,
      title: chapter_doc.title,
    });
    chapter_count += 1;
    if (!chapter_doc.tree) continue;

    const segs = adapter.segment(chapter_doc, {
      chapter_id: chapter.id,
      max_tokens: input.max_tokens,
      target_lang: input.target_lang,
    });
    for (const seg of segs) {
      const source_hash = await sha256Hex(seg.source_text);
      all_segments.push({
        id: newId(),
        chapter_id: seg.chapter_id,
        idx: seg.idx,
        source_text: seg.source_text,
        source_hash,
        target_text: null,
        inline_skeleton: seg.inline_skeleton,
        host_path: seg.host_path,
        host_part: seg.host_part,
        host_total_parts: seg.host_total_parts,
      });
    }
  }

  await bulkInsertSegments(input.project_id, all_segments);

  // Persist the cover thumbnail back into the library row so Projects
  // and Dashboard can render it without re-parsing the source ePub.
  // We write a *new ArrayBuffer* (not the underlying SharedArrayBuffer
  // backing the Uint8Array view) so Dexie's structured-clone path
  // doesn't choke on environments where the buffer is shared.
  let cover_extracted = false;
  if (book.cover) {
    try {
      const view = book.cover.bytes;
      const buf = new ArrayBuffer(view.byteLength);
      new Uint8Array(buf).set(view);
      await libraryDb().projects.update(input.project_id, {
        cover_image_bytes: buf,
        cover_image_media_type: book.cover.media_type,
      });
      cover_extracted = true;
    } catch {
      // Cover persistence is best-effort; we'd rather ship a project
      // with no thumbnail than fail intake outright.
    }
  }

  const duration_ms = Date.now() - start;
  await appendEvent(input.project_id, "chapters.imported", {
    chapter_count,
    segment_count: all_segments.length,
    duration_ms,
    cover_extracted,
  });

  // Phase 3: opportunistic background embedding pass. Runs only if
  // the caller supplied a provider — keeps intake fully offline by
  // default. We swallow per-pass failures: a half-embedded project is
  // perfectly usable (translation lazily fills the gaps).
  let embedded_segments: number | null = null;
  if (input.embedding_pass && all_segments.length > 0) {
    try {
      const { runEmbeddingPass } = await import("@/core/embedding_pass");
      const summary = await runEmbeddingPass(
        input.project_id,
        input.embedding_pass.provider,
        {
          batch_size_override: input.embedding_pass.batch_size_override,
          on_progress: input.embedding_pass.on_progress,
          signal: input.embedding_pass.signal,
        },
      );
      embedded_segments = summary.embedded;
    } catch {
      // Best-effort — embedding pass failures don't sink intake.
      embedded_segments = null;
    }
  }

  return {
    chapters: chapter_count,
    segments: all_segments.length,
    duration_ms,
    cover_extracted,
    embedded_segments,
  };
}
