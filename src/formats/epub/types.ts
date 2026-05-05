/**
 * Browser-port equivalents of `epublate.formats.base`.
 *
 * Differences vs Python:
 *   - `tree` is a DOM `Element` (the chapter `<html>` root) instead of an
 *     `lxml.etree._Element`. We hold the element rather than the document
 *     because the host XPaths are anchored to the element subtree.
 *   - `raw_xml` is `Uint8Array` rather than `bytes` so the writer can put
 *     it straight back into the ZIP without an extra encode step.
 *   - `host_path` is our own positional XPath dialect (see `xpath.ts`).
 */

export type InlineKind = "pair" | "void" | "entity";

export interface InlineToken {
  /**
   * Tag name in Clark notation (`{ns}local`) when the source is
   * namespaced, or just `local`. Mirrors the Python `InlineToken.tag`
   * shape so JSON exports flow round-trip.
   *
   * For `entity` tokens the tag is `&name;` (e.g. `&copy;`) and the
   * `attrs.name` carries the bare entity name. We rebuild named-entity
   * references on reassembly the same way Python does — except where
   * the parser stage expanded text entities to literal Unicode (see
   * `TEXT_ENTITY_EXPANSIONS`), in which case no `entity` token is ever
   * emitted in the first place.
   */
  tag: string;
  kind: InlineKind;
  attrs: Record<string, string>;
}

export interface Segment {
  id: string;
  chapter_id: string;
  idx: number;
  source_text: string;
  source_hash: string;
  target_text: string | null;
  inline_skeleton: InlineToken[];
  host_path: string;
  host_part: number;
  host_total_parts: number;
}

export interface ChapterDoc {
  spine_idx: number;
  href: string;
  /** Best-effort chapter title. May be null for non-document spine items. */
  title: string | null;
  media_type: string;
  /** Verbatim chapter bytes, used for documents that don't get translated. */
  raw_xml: Uint8Array;
  /** Parsed root element (`<html>`), or null for non-XHTML spine items. */
  tree: Element | null;
  /** Owning Document — kept so we can serialize back via XMLSerializer. */
  doc: Document | null;
  /**
   * The original `<!DOCTYPE ...>` declaration captured verbatim from
   * the source XHTML, including its public/system identifiers, or
   * `null` if the source had no DOCTYPE. We re-emit this string at
   * write time because XML serializers (including jsdom and at least
   * one major browser) silently drop single-quoted PUBLIC/SYSTEM
   * identifiers, breaking byte-for-byte round-trip on real Project
   * Gutenberg ePubs.
   */
  doctype_raw: string | null;
}

export interface CoverImage {
  /** OPF-relative path inside the ZIP (already-resolved). */
  href: string;
  /** MIME type from the manifest (`image/jpeg`, `image/png`, …). */
  media_type: string;
  /** Image bytes verbatim from the ZIP entry. */
  bytes: Uint8Array;
}

export interface Book {
  filename: string;
  title: string;
  language: string;
  /** OPF-relative paths for every spine entry, in order. */
  spine_hrefs: string[];
  chapters: ChapterDoc[];
  /** All ZIP entries from the original ePub, keyed by entry name. */
  zip_entries: Map<string, Uint8Array>;
  /** Parsed OPF, kept so the writer can emit an updated language attribute. */
  opf_path: string;
  opf_text: string;
  /**
   * Best-effort cover image extracted from the OPF metadata + manifest.
   * `null` when the ePub doesn't advertise a cover (rare in published
   * books, common in test fixtures).
   */
  cover: CoverImage | null;
}

export class EpubFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpubFormatError";
  }
}
