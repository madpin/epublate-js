/**
 * Chapter image surfacing for the Reader.
 *
 * The translation pipeline keeps `<img>` tags in the inline-skeleton
 * as void tokens — they round-trip verbatim on export. The Reader
 * historically rendered each image as a `[image: filename]` text
 * marker, which is great for placeholder bookkeeping but useless for
 * curators who want to see what the chapter actually looks like
 * (especially for illustrated novels).
 *
 * This module bridges that gap. Given a chapter's `<img>` tokens and
 * the underlying ePub bytes, we resolve each `src` against the chapter
 * href, pull the matching ZIP entry, build an `ObjectURL` for it, and
 * return a `(src) => url` lookup. The Reader then swaps the text
 * marker for an actual `<img>` element when the lookup succeeds.
 *
 * Two practical wrinkles, called out for posterity:
 *
 *   1. **Object URLs leak unless we revoke them.** Every consumer
 *      should call `revokeAll(map)` when the chapter changes — the
 *      hook in the Reader does this for you.
 *   2. **Standalone images.** When an `<img>` is the only thing in a
 *      `<p>`, the segmenter rejects the host (no translatable text),
 *      so the image never makes it into a segment row. We expose a
 *      separate `findStandaloneImages(book, chapter)` so the Reader
 *      can synthesize a "standalone image" card *between* segments,
 *      preserving document order.
 */

import { loadEpub } from "@/formats/epub/loader";
import {
  findTranslatableHosts,
  hoistOrphanedInlineRuns,
  isTriviallyEmpty,
  placeholderize,
} from "@/formats/epub/segmentation";
import type { Book, ChapterDoc, InlineToken } from "@/formats/epub/types";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

export interface ChapterImageMap {
  /**
   * Lookup keyed by the *raw* `src` / `href` value as it appears in
   * the inline-skeleton (e.g. "../images/cover.jpg"). Returns the
   * object URL or `null` when we couldn't resolve the entry.
   */
  byRawSrc: Map<string, string | null>;
  /** Every object URL we minted, for the revoker. */
  urls: string[];
  /** Resolved ZIP path → ObjectURL. Useful when the same image is reused. */
  byResolved: Map<string, string>;
}

/**
 * Build an object-URL map for every image referenced by inline-skeleton
 * tokens in a chapter.
 *
 * `book` and `chapter` come from `loadEpub(...)` — keep them around for
 * the lifetime of the Reader screen so re-builds are cheap. The same
 * book can serve every chapter; we resolve relative hrefs per chapter.
 */
export function buildChapterImageMap(
  book: Book,
  chapter: ChapterDoc,
  tokens: ReadonlyArray<readonly InlineToken[] | undefined>,
): ChapterImageMap {
  const byRawSrc = new Map<string, string | null>();
  const byResolved = new Map<string, string>();
  const urls: string[] = [];

  const visit = (token: InlineToken): void => {
    if (token.kind !== "void") return;
    const local = localName(token.tag).toLowerCase();
    if (local !== "img" && local !== "image") return;
    const raw = imageSrc(token);
    if (!raw) return;
    if (byRawSrc.has(raw)) return;
    const resolved = resolveAgainst(chapter.href, raw);
    if (!resolved) {
      byRawSrc.set(raw, null);
      return;
    }
    const cached = byResolved.get(resolved);
    let url: string | undefined = cached;
    if (!url) {
      const bytes = book.zip_entries.get(resolved);
      if (!bytes) {
        byRawSrc.set(raw, null);
        return;
      }
      const minted = bytesToObjectUrl(bytes, mimeForPath(resolved));
      if (!minted) {
        byRawSrc.set(raw, null);
        return;
      }
      url = minted;
      byResolved.set(resolved, url);
      urls.push(url);
    }
    byRawSrc.set(raw, url);
  };

  for (const skeleton of tokens) {
    if (!skeleton) continue;
    for (const token of skeleton) visit(token);
  }

  return { byRawSrc, urls, byResolved };
}

/**
 * Find images in the chapter source that the segmenter dropped on the
 * floor — typically illustrated chapters where each `<img>` lives in
 * its own `<p>` (or `<div>` / `<figure>`) and produces a non-translatable
 * host. Images that appear *inside* a non-empty translatable host are
 * deliberately omitted: the segmenter already encoded those as inline-
 * skeleton tokens, so the Reader will render them through
 * `image_resolver`. Picking them up here would result in the same
 * picture appearing twice — once inline, once as a "standalone card".
 *
 * Each returned record carries a `splice_at` index telling the caller
 * how many real translatable hosts appeared *before* the image in
 * document order. The Reader uses that to splice the image into the
 * segment list at the right spot — top-of-chapter illustrations land
 * before segment 0, end-of-chapter ones after the last segment, and
 * mid-chapter ones between the segments they actually neighbour.
 */
export interface StandaloneImage {
  /** Resolved ZIP path inside the ePub. */
  resolved: string;
  /** Verbatim `src` / `href` attribute as authored. */
  raw_src: string;
  alt: string | null;
  /**
   * Number of non-empty translatable hosts that preceded this image
   * in the chapter's document order. Used as the host-anchored splice
   * point: an image with `splice_at === 0` appears before the first
   * segment, `splice_at === N` (where `N` equals the number of hosts)
   * appears after the last segment.
   */
  splice_at: number;
}

export interface FindStandaloneImagesOptions {
  /**
   * Same `target_lang` filter the segmenter applies — blocks already
   * in the target language don't produce segments, so they shouldn't
   * count towards `splice_at` either. Pass `null`/`undefined` to
   * include every block (the safe default).
   */
  target_lang?: string | null;
}

export function findStandaloneImages(
  chapter: ChapterDoc,
  options: FindStandaloneImagesOptions = {},
): StandaloneImage[] {
  if (!chapter.tree) return [];

  // Mirror the segmenter's pre-pass so the host classification we do
  // here matches one-to-one what made it into the segments table at
  // intake. `hoistOrphanedInlineRuns` is idempotent so re-running on
  // a clean tree is a no-op.
  hoistOrphanedInlineRuns(chapter.tree);

  // Real (segment-producing) hosts vs every other element. Empty
  // translatable hosts (e.g. `<p><img/></p>`) intentionally land in
  // *neither* set: they don't bump the segment counter (segmenter
  // dropped them) but their child `<img>` still belongs in the
  // standalone list because nothing else surfaces it to the curator.
  const all_hosts = findTranslatableHosts(chapter.tree, {
    target_lang: options.target_lang ?? null,
  });
  const real_hosts = new Set<Element>();
  for (const host of all_hosts) {
    const { source_text } = placeholderize(host);
    if (!isTriviallyEmpty(source_text)) real_hosts.add(host);
  }

  let segment_count = 0;
  const out: StandaloneImage[] = [];

  const visit = (el: Element): void => {
    if (real_hosts.has(el)) {
      // Real translatable host: increment the splice-point counter
      // and *don't* recurse — its `<img>` children are inline-skeleton
      // tokens that the Reader resolves separately.
      segment_count += 1;
      return;
    }
    const local = el.localName.toLowerCase();
    if (local === "img" || local === "image") {
      const raw = readImgSrc(el);
      if (raw) {
        const resolved = resolveAgainst(chapter.href, raw);
        if (resolved) {
          out.push({
            resolved,
            raw_src: raw,
            alt:
              el.getAttribute("alt") ??
              el.getAttribute("aria-label") ??
              null,
            splice_at: segment_count,
          });
        }
      }
      return;
    }
    for (const child of Array.from(el.children)) visit(child);
  };
  visit(chapter.tree);
  return out;
}

/**
 * Convenience helper used by the Reader: load the book once, find the
 * chapter by spine href (the value `ChapterRow.href` already stores),
 * and return the `Book` + `ChapterDoc` pair.
 *
 * Returns `null` when the chapter href doesn't match any entry — this
 * happens on legacy projects that imported chapters before we started
 * persisting hrefs, and the Reader gracefully degrades to "no images".
 */
export async function loadChapterAssets(
  bytes: ArrayBuffer,
  chapter_href: string,
): Promise<{ book: Book; chapter: ChapterDoc } | null> {
  const book = await loadEpub(bytes);
  const chapter = book.chapters.find((c) => c.href === chapter_href) ?? null;
  if (!chapter) return null;
  return { book, chapter };
}

/** Tear down every minted object URL. Idempotent. */
export function revokeAll(map: ChapterImageMap): void {
  for (const url of map.urls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore — revoke fires once per page lifetime regardless
    }
  }
  map.urls.length = 0;
  map.byRawSrc.clear();
  map.byResolved.clear();
}

export function bytesToObjectUrl(
  bytes: Uint8Array,
  mime: string,
): string | null {
  if (typeof URL === "undefined" || typeof Blob === "undefined") return null;
  // Workaround: Uint8Array typing in some bundlers gets confused by
  // `new Blob([uint8])`. The cast is safe — the runtime accepts it.
  const blob = new Blob([bytes as BlobPart], { type: mime });
  return URL.createObjectURL(blob);
}

function imageSrc(token: InlineToken): string | null {
  if (!token.attrs) return null;
  // <img src> first, <image href|xlink:href> for inline SVG.
  return (
    nonEmpty(token.attrs.src) ??
    nonEmpty(token.attrs.href) ??
    nonEmpty(token.attrs["xlink:href"]) ??
    null
  );
}

function readImgSrc(el: Element): string | null {
  const direct =
    el.getAttribute("src") ??
    el.getAttribute("href") ??
    el.getAttributeNS(XLINK_NS, "href");
  return nonEmpty(direct);
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function localName(tag: string): string {
  if (tag.startsWith("{")) {
    const idx = tag.indexOf("}");
    if (idx >= 0) return tag.slice(idx + 1);
  }
  return tag;
}

function resolveAgainst(host_href: string, src: string): string | null {
  if (!src) return null;
  if (src.startsWith("data:")) return null;
  // Absolute URLs (`http://…`, `https://…`) can't be served from the
  // ZIP. We bail rather than 404 the curator.
  if (/^[a-z][a-z0-9+\-.]*:/i.test(src)) return null;
  // Strip URL fragments / queries — image hosts inside ZIPs never use
  // them, and decodeURIComponent below would otherwise blow up on `?`.
  const cleaned = src.split("#")[0].split("?")[0];
  if (!cleaned) return null;
  const decoded = decodeUriComponentSafe(cleaned);
  // Anchor on the chapter's directory.
  const lastSlash = host_href.lastIndexOf("/");
  const base = lastSlash >= 0 ? host_href.slice(0, lastSlash + 1) : "";
  // Absolute path reference (`/cover.jpg`) — treat it as ZIP-root
  // relative.
  if (decoded.startsWith("/")) return normalizePath(decoded.slice(1));
  return normalizePath(base + decoded);
}

function decodeUriComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function normalizePath(p: string): string {
  const segments: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

export function mimeForPath(href: string): string {
  const lower = href.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".avif")) return "image/avif";
  return "application/octet-stream";
}

// Re-export commonly-needed namespaces for tests / consumers that need
// to inspect element nodes directly.
export const NS = {
  XHTML: XHTML_NS,
  SVG: SVG_NS,
  XLINK: XLINK_NS,
};
