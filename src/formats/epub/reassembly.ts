/**
 * Stitch translated segments back into a chapter (mirrors
 * `EpubAdapter.reassemble`).
 *
 * The flow:
 *
 *   1. Re-run `hoistOrphanedInlineRuns` on the chapter tree so the
 *      synthetic `<div>` wrappers exist before any host-path lookup.
 *      Idempotent.
 *   2. Group the segments by `host_path`, sorted by `host_part`.
 *   3. For each group, validate placeholders, restore outer
 *      whitespace, then call `applyParts(host, parts)`.
 */

import { findByXPath } from "./xpath";
import {
  applyParts,
  hoistOrphanedInlineRuns,
  restoreOuterWhitespace,
  validateSegmentPlaceholders,
  type Part,
} from "./segmentation";
import {
  EpubFormatError,
  type ChapterDoc,
  type Segment,
} from "./types";

export function reassembleChapter(
  doc: ChapterDoc,
  translated: Segment[],
): void {
  if (!doc.tree) return;
  hoistOrphanedInlineRuns(doc.tree);

  const byPath = new Map<string, Segment[]>();
  for (const seg of translated) {
    const list = byPath.get(seg.host_path) ?? [];
    list.push(seg);
    byPath.set(seg.host_path, list);
  }

  for (const [host_path, segs] of byPath) {
    segs.sort((a, b) => a.host_part - b.host_part);
    const host = findByXPath(doc.tree, host_path);
    if (!host) {
      throw new EpubFormatError(
        `reassemble: host_path ${host_path} not found in chapter`,
      );
    }
    for (const seg of segs) validateSegmentPlaceholders(seg);
    const parts: Part[] = segs.map((seg) => {
      const text =
        seg.target_text === null
          ? seg.source_text
          : restoreOuterWhitespace(seg.source_text, seg.target_text);
      return [text, seg.inline_skeleton] as const;
    });
    applyParts(host, parts);
  }
}
