/**
 * EpubAdapter — public surface for the rest of the app.
 *
 * Mirrors `epublate.formats.epub.EpubAdapter` and ties together the
 * loader, segmenter, reassembler, and writer modules. The pipeline,
 * project layer, and Reader UI all interact with ePubs through this
 * single object.
 */

import { newId } from "@/lib/id";
import { sha256Hex } from "@/lib/hash";

import type { FormatAdapter, SaveOptions, SegmentOptions } from "../base";
import { loadEpub } from "./loader";
import { reassembleChapter } from "./reassembly";
import {
  findTranslatableHosts,
  hoistOrphanedInlineRuns,
  isTriviallyEmpty,
  placeholderize,
  splitBySentences,
} from "./segmentation";
import type { Book, ChapterDoc, Segment } from "./types";
import { getXPath } from "./xpath";
import { buildEpubBlob } from "./writer";

export const DEFAULT_MAX_TOKENS = 800;

export class EpubAdapter implements FormatAdapter {
  readonly name = "epub" as const;

  async load(
    bytes: ArrayBuffer | Uint8Array,
    opts: { filename?: string } = {},
  ): Promise<Book> {
    return loadEpub(bytes, opts);
  }

  iterChapters(book: Book): ChapterDoc[] {
    return book.chapters;
  }

  segment(doc: ChapterDoc, opts: SegmentOptions): Segment[] {
    if (!doc.tree) return [];
    const max_tokens = opts.max_tokens ?? DEFAULT_MAX_TOKENS;
    const target_lang = opts.target_lang ?? null;
    // Idempotent pre-pass — see `hoistOrphanedInlineRuns` doc.
    hoistOrphanedInlineRuns(doc.tree);

    const segments: Segment[] = [];
    const hosts = findTranslatableHosts(doc.tree, { target_lang });
    for (const host of hosts) {
      const { source_text, skeleton } = placeholderize(host);
      if (isTriviallyEmpty(source_text)) continue;
      const host_path = getXPath(doc.tree, host);
      const parts = splitBySentences(source_text, skeleton, { max_tokens });
      parts.forEach((part, host_part) => {
        segments.push({
          id: newId(),
          chapter_id: opts.chapter_id,
          idx: segments.length,
          source_text: part.source_text,
          // Placeholder; callers fill in the async hash via `attachHashes`.
          source_hash: "",
          target_text: null,
          inline_skeleton: part.skeleton,
          host_path,
          host_part,
          host_total_parts: parts.length,
        });
      });
    }
    return segments;
  }

  reassemble(doc: ChapterDoc, translated: Segment[]): void {
    reassembleChapter(doc, translated);
  }

  save(book: Book, opts: SaveOptions = {}): Promise<Blob> {
    return buildEpubBlob(book, opts);
  }
}

/**
 * Compute and assign `source_hash` for every segment.
 *
 * `segment()` is sync (it has to be — the format protocol is sync)
 * but Web Crypto's SHA-256 is async, so we expose a separate pass
 * the project layer can `await` after segmentation. Tests that don't
 * care about hash stability can skip this.
 */
export async function attachSourceHashes(segments: Segment[]): Promise<void> {
  for (const seg of segments) {
    if (!seg.source_hash) {
      seg.source_hash = await sha256Hex(seg.source_text);
    }
  }
}

export {
  loadEpub,
  reassembleChapter,
  buildEpubBlob,
  findTranslatableHosts,
  hoistOrphanedInlineRuns,
  isTriviallyEmpty,
  placeholderize,
  splitBySentences,
  getXPath,
};
