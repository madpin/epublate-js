/**
 * Format-agnostic adapter Protocol. Mirrors `epublate.formats.base`.
 *
 * The pipeline never speaks raw bytes; it goes through this surface so
 * future formats (PDF, plain HTML) can plug in without touching the
 * core. v1 ships only `EpubAdapter`.
 */

import type { Book, ChapterDoc, Segment } from "./epub/types";

export interface SegmentOptions {
  chapter_id: string;
  /** Soft cap (in chars/4) per segment. Long blocks split at sentence boundaries. */
  max_tokens?: number;
  /** Skip blocks that already speak the target language. */
  target_lang?: string | null;
}

export interface FormatAdapter {
  readonly name: string;
  load(bytes: ArrayBuffer | Uint8Array, opts?: { filename?: string }): Promise<Book>;
  /** Iterate parsed spine docs in order. */
  iterChapters(book: Book): ChapterDoc[];
  /** Build the segment list for one chapter. Pure (no DB writes). */
  segment(doc: ChapterDoc, opts: SegmentOptions): Segment[];
  /** Mutates `doc.tree` in place; used at export time. */
  reassemble(doc: ChapterDoc, translated: Segment[]): void;
  /** Produce a new ePub blob, writing chapter mutations + OPF tweaks. */
  save(book: Book, opts?: SaveOptions): Promise<Blob>;
}

export interface SaveOptions {
  target_lang?: string | null;
  provenance?: string;
}
