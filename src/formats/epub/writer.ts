/**
 * Build an updated ePub Blob from a `Book` whose chapter trees have
 * already been reassembled.
 *
 * Mirrors `EpubAdapter.save` semantics:
 *
 *   - Writes the `mimetype` entry first, uncompressed (ePub spec).
 *   - All other ZIP entries from the source bundle pass through
 *     verbatim *except* the chapters whose tree we mutated, plus the
 *     OPF when we updated the language. Stylesheets, fonts, images,
 *     and the `META-INF/container.xml` go through unchanged.
 *   - Adds an `epublate <version>` provenance line in the OPF when
 *     we know the target language; idempotent on re-export.
 */

import JSZip from "jszip";

import { type Book } from "./types";

const MIMETYPE_FILENAME = "mimetype";
const MIMETYPE_VALUE = "application/epub+zip";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';

export interface BuildEpubOptions {
  /** When set, mutates OPF metadata so readers display the right language. */
  target_lang?: string | null;
  /** Provenance string added to OPF as `dc:contributor`. Default: `epublate-js`. */
  provenance?: string;
}

async function buildZip(
  book: Book,
  options: BuildEpubOptions,
): Promise<JSZip> {
  const zip = new JSZip();
  zip.file(MIMETYPE_FILENAME, MIMETYPE_VALUE, {
    compression: "STORE",
  });

  // Updated entries replace originals byte-for-byte, keyed by zip
  // entry name. Chapters we mutated, plus a possibly-updated OPF.
  const updated = new Map<string, string>();
  for (const chapter of book.chapters) {
    if (chapter.tree && chapter.doc) {
      const serialized = serializeXhtml(chapter.doc, {
        target_lang: options.target_lang ?? null,
        doctype_raw: chapter.doctype_raw ?? null,
      });
      updated.set(chapter.href, serialized);
    }
  }
  if (options.target_lang) {
    const opf = updateOpf(book.opf_text, {
      target_lang: options.target_lang,
      provenance: options.provenance ?? "epublate-js",
    });
    updated.set(book.opf_path, opf);
  }

  for (const [name, bytes] of book.zip_entries) {
    if (name === MIMETYPE_FILENAME) continue;
    const replacement = updated.get(name);
    if (replacement !== undefined) {
      // String form: JSZip handles UTF-8 encoding internally and stays
      // robust across both browser and jsdom. The chapter / OPF bytes
      // we hold are guaranteed UTF-8 because that's what `loadEpub`
      // decoded them as in the first place.
      zip.file(name, replacement);
    } else {
      // Pass-through verbatim — copy the bytes into a stand-alone
      // typed array so JSZip doesn't choke on a typed-array view
      // returned by some IDB backends (notably `fake-indexeddb` in
      // tests). We deliberately do NOT decode-then-encode text
      // entries: that would silently strip BOMs, normalize Unicode,
      // or mangle stylesheets/SVG declared in non-UTF-8 charsets.
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      zip.file(name, copy);
    }
  }
  return zip;
}

export async function buildEpubBlob(
  book: Book,
  options: BuildEpubOptions = {},
): Promise<Blob> {
  const zip = await buildZip(book, options);
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

/**
 * Same as `buildEpubBlob` but returns the raw bytes — useful in tests
 * (jsdom's `Blob` doesn't implement `arrayBuffer()`) and when re-
 * importing an exported ePub straight back into IndexedDB.
 */
export async function buildEpubBytes(
  book: Book,
  options: BuildEpubOptions = {},
): Promise<Uint8Array> {
  const zip = await buildZip(book, options);
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";

interface SerializeOptions {
  target_lang: string | null;
  doctype_raw: string | null;
}

function serializeXhtml(doc: Document, options: SerializeOptions): string {
  if (options.target_lang) {
    const root = doc.documentElement;
    if (root && root.localName === "html") {
      root.setAttribute("lang", options.target_lang);
      root.setAttributeNS(XML_NS, "xml:lang", options.target_lang);
    }
  }

  // Patch namespaces: when we cloned/created elements in `applyParts`
  // with `createElementNS(null, ...)`, the serializer emits an
  // explicit `xmlns=""` reset on them. That validates differently
  // depending on the reader and changes the byte output. To keep
  // round-trips clean we walk the tree and re-create those nodes
  // under the host's inherited namespace.
  if (doc.documentElement) {
    repairInheritedNamespace(doc.documentElement);
    // Internal segmentation markers (e.g. the orphan-wrapper `div`s)
    // must not leak into the exported file. Strip every
    // `data-epublate-*` attribute before serialization. epubcheck
    // (and the EPUB 2/3 schemas) reject unknown `data-` attributes
    // on inline elements when running in non-HTML5 mode.
    stripInternalAttributes(doc.documentElement);
  }

  const serializer = new XMLSerializer();
  // We assemble the prologue ourselves rather than letting the
  // serializer do it: jsdom's serializer (and at least one major
  // browser) drop the PUBLIC/SYSTEM identifiers from `<!DOCTYPE>`
  // when re-serializing a `Document`, which rewrites a Project-
  // Gutenberg-style EPUB 2 chapter from
  //   <!DOCTYPE html PUBLIC '-//W3C//DTD XHTML 1.1//EN' '...'>
  // to
  //   <!DOCTYPE html>
  // and trips epubcheck's HTM-004 "Irregular DOCTYPE" error. We
  // therefore prefer the verbatim DOCTYPE captured at load-time
  // (which preserves single-quoted identifiers); only fall back to
  // re-synthesising from `doc.doctype` when we couldn't capture one.
  const doctype = options.doctype_raw
    ? options.doctype_raw + "\n"
    : serializeDoctype(doc.doctype);
  const rootMarkup = doc.documentElement
    ? serializer.serializeToString(doc.documentElement)
    : "";
  return XML_DECL + doctype + rootMarkup;
}

function serializeDoctype(dt: DocumentType | null | undefined): string {
  if (!dt || !dt.name) return "";
  const pub = dt.publicId;
  const sys = dt.systemId;
  if (pub && sys) {
    return `<!DOCTYPE ${dt.name} PUBLIC "${pub}" "${sys}">\n`;
  }
  if (sys) {
    return `<!DOCTYPE ${dt.name} SYSTEM "${sys}">\n`;
  }
  return `<!DOCTYPE ${dt.name}>\n`;
}

const INTERNAL_ATTR_PREFIX = "data-epublate-";

function stripInternalAttributes(root: Element): void {
  // `getElementsByTagName('*')` is a live HTMLCollection; iterate
  // over a snapshot to avoid surprises if the DOM mutates underneath
  // us (it shouldn't, but better safe than sorry).
  const all: Element[] = [root, ...Array.from(root.getElementsByTagName("*"))];
  for (const el of all) {
    const attrs = el.attributes;
    if (!attrs) continue;
    for (let i = attrs.length - 1; i >= 0; i -= 1) {
      const name = attrs[i]?.name ?? "";
      if (name.startsWith(INTERNAL_ATTR_PREFIX)) {
        el.removeAttribute(name);
      }
    }
  }
}

/**
 * Walk `root` and recreate every namespace-less element under its
 * parent's namespace, copying children verbatim. We use this only on
 * elements we built in `applyParts` (the writer never sees foreign
 * namespaceless content from a real ePub because DOMParser inherits
 * the default namespace correctly during parse).
 */
function repairInheritedNamespace(root: Element): void {
  const owner = root.ownerDocument;
  if (!owner) return;
  const fixOne = (el: Element): Element => {
    const inherited = el.parentElement?.namespaceURI ?? root.namespaceURI;
    if (el.namespaceURI === null && inherited && inherited !== "") {
      const replacement = owner.createElementNS(inherited, el.localName);
      for (const attr of Array.from(el.attributes)) {
        if (attr.namespaceURI) {
          replacement.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
        } else {
          replacement.setAttribute(attr.name, attr.value);
        }
      }
      while (el.firstChild) replacement.appendChild(el.firstChild);
      el.parentNode?.replaceChild(replacement, el);
      return replacement;
    }
    return el;
  };
  // Two-pass: collect candidates first, then replace.
  const stack: Element[] = [];
  const walker = owner.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let cur = walker.nextNode() as Element | null;
  while (cur) {
    if (cur.namespaceURI === null) stack.push(cur);
    cur = walker.nextNode() as Element | null;
  }
  for (const el of stack) {
    const replaced = fixOne(el);
    if (replaced !== el) {
      // Recurse into children of the replacement, since they may also
      // need fixing.
      let kid = replaced.firstElementChild;
      while (kid) {
        repairInheritedNamespace(kid);
        kid = kid.nextElementSibling;
      }
    }
  }
}

const DC_NS = "http://purl.org/dc/elements/1.1/";

function updateOpf(
  opfText: string,
  options: { target_lang: string; provenance: string },
): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(opfText, "application/xml");
  if (!doc.documentElement) return opfText;

  const lang = doc.getElementsByTagNameNS(DC_NS, "language");
  if (lang.length > 0) {
    while (lang[0].firstChild) lang[0].removeChild(lang[0].firstChild);
    lang[0].appendChild(doc.createTextNode(options.target_lang));
    // Drop any extras to avoid duplicates.
    for (let i = 1; i < lang.length; i++) {
      lang[i].parentNode?.removeChild(lang[i]);
    }
  }

  // Add provenance dc:contributor with id="epublate-provenance" if not already present.
  const contributors = doc.getElementsByTagNameNS(DC_NS, "contributor");
  let already = false;
  for (const c of Array.from(contributors)) {
    if (c.getAttribute("id") === "epublate-provenance") {
      already = true;
      break;
    }
  }
  if (!already) {
    const metadata =
      doc.getElementsByTagName("metadata")[0] ??
      doc.getElementsByTagNameNS("http://www.idpf.org/2007/opf", "metadata")[0];
    if (metadata) {
      const contrib = doc.createElementNS(DC_NS, "dc:contributor");
      contrib.setAttribute("id", "epublate-provenance");
      contrib.appendChild(doc.createTextNode(options.provenance));
      metadata.appendChild(contrib);
    }
  }

  const serializer = new XMLSerializer();
  const doctype = serializeDoctype(doc.doctype);
  const root = doc.documentElement
    ? serializer.serializeToString(doc.documentElement)
    : "";
  return XML_DECL + doctype + root;
}
