/**
 * Browser-side ePub loader (JSZip + DOMParser).
 *
 * Mirrors `epublate.formats.epub.EpubAdapter.load` + `iter_chapters`.
 * Differences:
 *
 *   - We don't depend on `ebooklib`. We load the ZIP, parse the OPF +
 *     `container.xml` ourselves, and walk the manifest for spine
 *     items.
 *   - Named XHTML entities are flattened to literal Unicode before
 *     parsing — see `entities.ts`.
 *   - We retain the **full** original ZIP (`zip_entries` map) so the
 *     writer can produce an updated bundle without re-fetching
 *     anything from disk. This is the browser equivalent of
 *     ebooklib's "keep `item.content` around verbatim" trick the
 *     Python adapter uses to preserve `<head>`, stylesheets, and
 *     other non-translatable assets.
 */

import JSZip from "jszip";

import { expandNamedEntities } from "./entities";
import {
  type Book,
  type ChapterDoc,
  type CoverImage,
  EpubFormatError,
} from "./types";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const OPF_NS = "http://www.idpf.org/2007/opf";
const DC_NS = "http://purl.org/dc/elements/1.1/";

const XHTML_MEDIA_TYPES = new Set([
  "application/xhtml+xml",
  "application/x-dtbook+xml",
  "application/xml",
  "text/html",
]);

/**
 * Load an ePub from raw bytes.
 *
 * The returned `Book` carries all data the rest of the pipeline + the
 * writer need; nothing else needs to read the original blob.
 */
export async function loadEpub(
  bytes: ArrayBuffer | Uint8Array,
  options: { filename?: string } = {},
): Promise<Book> {
  const zip = await JSZip.loadAsync(bytes);

  const entries = new Map<string, Uint8Array>();
  await Promise.all(
    Object.values(zip.files).map(async (entry) => {
      if (entry.dir) return;
      const data = await entry.async("uint8array");
      entries.set(entry.name, data);
    }),
  );

  const containerBytes = entries.get("META-INF/container.xml");
  if (!containerBytes) {
    throw new EpubFormatError("ePub is missing META-INF/container.xml");
  }
  const containerText = decodeUtf8(containerBytes);
  const containerDoc = parseXml(containerText, "META-INF/container.xml");
  const rootFileEl = containerDoc.querySelector("rootfile");
  if (!rootFileEl) {
    throw new EpubFormatError(
      "container.xml has no <rootfile> entry",
    );
  }
  const opfPath = rootFileEl.getAttribute("full-path");
  if (!opfPath) {
    throw new EpubFormatError("container.xml rootfile has no full-path attribute");
  }

  const opfBytes = entries.get(opfPath);
  if (!opfBytes) {
    throw new EpubFormatError(`OPF file not found in ePub: ${opfPath}`);
  }
  const opfText = decodeUtf8(opfBytes);
  const opfDoc = parseXml(opfText, opfPath);

  const manifest = parseManifest(opfDoc, opfPath);
  const spineHrefs = parseSpine(opfDoc, manifest);
  const title = readDcMetadata(opfDoc, "title") ?? options.filename ?? "(untitled)";
  const language = readDcMetadata(opfDoc, "language") ?? "und";

  const chapters: ChapterDoc[] = [];
  spineHrefs.forEach((href, spine_idx) => {
    const data = entries.get(href);
    if (!data) {
      throw new EpubFormatError(`spine entry not found in ePub: ${href}`);
    }
    const media_type = manifest.byHref.get(href)?.media_type ?? "application/xhtml+xml";
    const isXhtml = XHTML_MEDIA_TYPES.has(media_type);
    let tree: Element | null = null;
    let chapterDoc: Document | null = null;
    let title: string | null = null;
    let doctypeRaw: string | null = null;
    if (isXhtml) {
      const text = decodeUtf8(data);
      doctypeRaw = extractDoctype(text);
      const expanded = expandNamedEntities(text);
      chapterDoc = parseXml(expanded, href);
      tree = chapterDoc.documentElement;
      title = extractChapterTitle(tree);
    }
    chapters.push({
      spine_idx,
      href,
      title,
      media_type,
      raw_xml: data,
      tree,
      doc: chapterDoc,
      doctype_raw: doctypeRaw,
    });
  });

  const cover = findCoverImage(opfDoc, manifest, entries);

  return {
    filename: options.filename ?? "book.epub",
    title,
    language,
    spine_hrefs: spineHrefs,
    chapters,
    zip_entries: entries,
    opf_path: opfPath,
    opf_text: opfText,
    cover,
  };
}

/**
 * Locate the cover image referenced by the OPF.
 *
 * We try the two standard mechanisms in order:
 *
 * 1. **EPUB 3** — manifest item with `properties="cover-image"`. This
 *    is the spec-mandated path for any reasonably modern book.
 * 2. **EPUB 2** — `<meta name="cover" content="<manifest-id>" />`
 *    inside `<metadata>`, where the referenced manifest item points at
 *    the cover image. Project Gutenberg and a lot of older converters
 *    still rely on this.
 *
 * Both lookups land on a manifest entry that carries the cover's
 * resolved href and media type; we then read the bytes out of the ZIP.
 * Returning `null` when nothing matches keeps the loader honest — many
 * sample/test fixtures genuinely have no cover.
 */
function findCoverImage(
  opfDoc: Document,
  manifest: Manifest,
  entries: Map<string, Uint8Array>,
): CoverImage | null {
  // 1) EPUB 3: manifest item with properties="cover-image".
  const items = Array.from(
    opfDoc.getElementsByTagNameNS(OPF_NS, "item"),
  ).concat(Array.from(opfDoc.getElementsByTagName("item")));
  const seen = new Set<Element>();
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    const props = (item.getAttribute("properties") ?? "").split(/\s+/);
    if (!props.includes("cover-image")) continue;
    const id = item.getAttribute("id");
    if (!id) continue;
    const entry = manifest.byId.get(id);
    if (!entry) continue;
    const bytes = entries.get(entry.href);
    if (!bytes) continue;
    return {
      href: entry.href,
      media_type: entry.media_type || guessImageMime(entry.href),
      bytes,
    };
  }

  // 2) EPUB 2: <meta name="cover" content="<manifest-id>" />.
  const metas = Array.from(opfDoc.getElementsByTagName("meta"));
  for (const meta of metas) {
    const name = meta.getAttribute("name");
    if (name !== "cover") continue;
    const ref = meta.getAttribute("content");
    if (!ref) continue;
    const entry = manifest.byId.get(ref);
    if (!entry) continue;
    if (!entry.media_type.startsWith("image/")) {
      // Some older converters point at the cover's *XHTML page*
      // instead of the image. Try to find a sibling image item.
      continue;
    }
    const bytes = entries.get(entry.href);
    if (!bytes) continue;
    return {
      href: entry.href,
      media_type: entry.media_type || guessImageMime(entry.href),
      bytes,
    };
  }

  return null;
}

function guessImageMime(href: string): string {
  const lower = href.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg"))
    return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

interface ManifestEntry {
  id: string;
  href: string;
  media_type: string;
}

interface Manifest {
  byId: Map<string, ManifestEntry>;
  byHref: Map<string, ManifestEntry>;
}

function parseManifest(opfDoc: Document, opfPath: string): Manifest {
  const byId = new Map<string, ManifestEntry>();
  const byHref = new Map<string, ManifestEntry>();
  const items = Array.from(
    opfDoc.getElementsByTagNameNS(OPF_NS, "item"),
  ).concat(Array.from(opfDoc.getElementsByTagName("item")));
  const seen = new Set<Element>();
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    const media_type = item.getAttribute("media-type") ?? "";
    if (!id || !href) continue;
    const resolved = resolveHref(opfPath, href);
    const entry: ManifestEntry = { id, href: resolved, media_type };
    byId.set(id, entry);
    byHref.set(resolved, entry);
  }
  return { byId, byHref };
}

function parseSpine(opfDoc: Document, manifest: Manifest): string[] {
  const itemrefs: Element[] = [];
  const direct = opfDoc.getElementsByTagNameNS(OPF_NS, "itemref");
  if (direct.length > 0) {
    for (const el of Array.from(direct)) itemrefs.push(el);
  } else {
    for (const el of Array.from(opfDoc.getElementsByTagName("itemref"))) {
      itemrefs.push(el);
    }
  }
  const out: string[] = [];
  for (const ref of itemrefs) {
    const idref = ref.getAttribute("idref");
    if (!idref) continue;
    const entry = manifest.byId.get(idref);
    if (entry) out.push(entry.href);
  }
  return out;
}

function readDcMetadata(opfDoc: Document, key: string): string | null {
  const ns = opfDoc.getElementsByTagNameNS(DC_NS, key);
  if (ns.length > 0) {
    const text = ns[0].textContent?.trim();
    if (text) return text;
  }
  // Some OPFs use the `dc:` prefix even though they didn't declare the
  // namespace properly. Try a literal-name fallback.
  const direct = opfDoc.getElementsByTagName(`dc:${key}`);
  if (direct.length > 0) {
    const text = direct[0].textContent?.trim();
    if (text) return text;
  }
  return null;
}

const TITLE_HEADING_TAGS: ReadonlyArray<string> = ["h1", "h2", "h3"];

function extractChapterTitle(root: Element): string | null {
  for (const tag of TITLE_HEADING_TAGS) {
    const els = root.getElementsByTagNameNS(XHTML_NS, tag);
    for (const el of Array.from(els)) {
      const text = el.textContent?.trim();
      if (text) return normalizeWs(text);
    }
    const fallback = root.getElementsByTagName(tag);
    for (const el of Array.from(fallback)) {
      const text = el.textContent?.trim();
      if (text) return normalizeWs(text);
    }
  }
  // <title> in <head>
  const titleEls = root.getElementsByTagName("title");
  for (const el of Array.from(titleEls)) {
    const text = el.textContent?.trim();
    if (text) return normalizeWs(text);
  }
  return null;
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const DOCTYPE_RE = /<!DOCTYPE[\s\S]*?>/i;

/**
 * Pull the verbatim `<!DOCTYPE ...>` declaration out of the source
 * text. We need this because `DOMParser` round-trips drop the
 * PUBLIC/SYSTEM identifiers when they're single-quoted (jsdom and at
 * least one major browser exhibit this), which invalidates a real
 * Project Gutenberg-style EPUB 2 chapter on re-export. Returning
 * `null` when there's no DOCTYPE matches the prior writer behavior.
 */
export function extractDoctype(xml: string): string | null {
  // Only scan the prologue — at most a few KB before the root element.
  // Capping the search is also a defense against accidentally matching
  // a `<!DOCTYPE` literal inside a string buried in a `<script>` block.
  const head = xml.slice(0, 4096);
  const match = head.match(DOCTYPE_RE);
  return match ? match[0] : null;
}

function resolveHref(opfPath: string, href: string): string {
  // OPF entries are relative to the OPF directory.
  const lastSlash = opfPath.lastIndexOf("/");
  const base = lastSlash >= 0 ? opfPath.slice(0, lastSlash + 1) : "";
  // Decode %xx escapes; ePub spec mandates URL-encoded hrefs.
  const decoded = decodeUriComponentSafe(href);
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

const TEXT_DECODER = new TextDecoder("utf-8");

export function decodeUtf8(bytes: Uint8Array): string {
  return TEXT_DECODER.decode(bytes);
}

const TEXT_ENCODER = new TextEncoder();

export function encodeUtf8(text: string): Uint8Array {
  return TEXT_ENCODER.encode(text);
}

export function parseXml(text: string, source_label: string): Document {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "application/xhtml+xml");
  const err = doc.getElementsByTagName("parsererror");
  if (err.length > 0) {
    const msg = (err[0].textContent ?? "unknown parser error").trim();
    throw new EpubFormatError(
      `failed to parse XML in ${source_label}: ${msg.slice(0, 200)}`,
    );
  }
  return doc;
}
