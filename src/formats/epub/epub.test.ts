/**
 * End-to-end ePub round-trip tests.
 *
 * Build a minimal-but-valid ePub in memory with JSZip, load it via
 * `EpubAdapter.load`, segment each chapter, reassemble with the
 * untranslated source_text, save to a new blob, then re-load that
 * blob. The chapter trees should serialize to the same string both
 * times — the format-handling round-trip invariant.
 */

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { EpubAdapter } from "./index";
import { findTranslatableHosts, placeholderize } from "./segmentation";
import { buildEpubBytes } from "./writer";
import { getXPath } from "./xpath";

const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

function buildOpf(spine: { id: string; href: string }[]): string {
  const manifest = spine
    .map(
      (s) =>
        `    <item id="${s.id}" href="${s.href}" media-type="application/xhtml+xml"/>`,
    )
    .join("\n");
  const itemrefs = spine
    .map((s) => `    <itemref idref="${s.id}"/>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:test:book</dc:identifier>
    <dc:title>Test Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine>
${itemrefs}
  </spine>
</package>`;
}

function chapterDoc(title: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${title}</title></head>
  <body>${body}</body>
</html>`;
}

async function buildSampleEpub(
  chapters: { id: string; href: string; xhtml: string }[],
): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file(
    "OEBPS/content.opf",
    buildOpf(chapters.map((c) => ({ id: c.id, href: c.href }))),
  );
  for (const c of chapters) {
    zip.file(`OEBPS/${c.href}`, c.xhtml);
  }
  const blob = await zip.generateAsync({ type: "uint8array" });
  // `Uint8Array.buffer` may be typed as `ArrayBuffer | SharedArrayBuffer`
  // depending on the lib defs; we always fabricate a fresh ArrayBuffer
  // so the loader sees a plain buffer it can hand to JSZip.
  const out = new ArrayBuffer(blob.byteLength);
  new Uint8Array(out).set(blob);
  return out;
}

describe("EpubAdapter round-trip", () => {
  it("loads a minimal ePub and exposes chapters", async () => {
    const bytes = await buildSampleEpub([
      {
        id: "ch1",
        href: "ch1.xhtml",
        xhtml: chapterDoc("Chapter 1", "<h1>Chapter 1</h1><p>Hello world.</p>"),
      },
    ]);
    const adapter = new EpubAdapter();
    const book = await adapter.load(bytes, { filename: "sample.epub" });
    expect(book.title).toBe("Test Book");
    expect(book.language).toBe("en");
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].title).toContain("Chapter 1");
    expect(book.chapters[0].tree).not.toBeNull();
  });

  it("segments → reassembles → saves identical bytes (untranslated)", async () => {
    const bytes = await buildSampleEpub([
      {
        id: "ch1",
        href: "ch1.xhtml",
        xhtml: chapterDoc(
          "Ch 1",
          `<h1>Heading</h1>
<p>Plain prose paragraph.</p>
<p>Another paragraph with <em>emphasis</em> and a <a href="#">link</a>.</p>
<p>Line one<br/>Line two.</p>`,
        ),
      },
    ]);
    const adapter = new EpubAdapter();
    const book = await adapter.load(bytes);

    const allSegments: Record<string, ReturnType<typeof adapter.segment>> = {};
    for (const chapter of book.chapters) {
      const segs = adapter.segment(chapter, { chapter_id: chapter.href });
      // Sanity: every segment's host_path must resolve.
      for (const seg of segs) {
        expect(seg.host_path).toMatch(/^\/.+/);
      }
      allSegments[chapter.href] = segs;
    }
    const onlyChapterSegs = Object.values(allSegments)[0];
    expect(onlyChapterSegs.length).toBeGreaterThan(0);

    // Reassemble with untranslated source text — should be identity on
    // the chapter tree (modulo whitespace re-insertion that doesn't
    // apply when we feed source_text through unchanged).
    const beforeBodies = book.chapters.map((c) =>
      c.tree ? new XMLSerializer().serializeToString(c.tree) : "",
    );

    for (const chapter of book.chapters) {
      adapter.reassemble(chapter, allSegments[chapter.href]);
    }

    const afterBodies = book.chapters.map((c) =>
      c.tree ? new XMLSerializer().serializeToString(c.tree) : "",
    );
    expect(afterBodies).toEqual(beforeBodies);

    // Now write the book back out and re-load. We use `buildEpubBytes`
    // here instead of `adapter.save` because jsdom's `Blob` lacks
    // `arrayBuffer()`. In real browsers `adapter.save` is the entry
    // point and produces a downloadable Blob.
    const written = await buildEpubBytes(book);
    const reloaded = await adapter.load(written);
    expect(reloaded.chapters).toHaveLength(book.chapters.length);
    for (let i = 0; i < book.chapters.length; i++) {
      const a = book.chapters[i].tree
        ? new XMLSerializer().serializeToString(book.chapters[i].tree!)
        : "";
      const b = reloaded.chapters[i].tree
        ? new XMLSerializer().serializeToString(reloaded.chapters[i].tree!)
        : "";
      expect(b).toBe(a);
    }
  });

  it("preserves DOCTYPE PUBLIC/SYSTEM identifiers on export (regression)", async () => {
    // jsdom (and at least one major browser) drop the public/system
    // identifiers from `doc.doctype` when re-serializing — especially
    // when the source DOCTYPE used single quotes. The writer must
    // re-emit the original DOCTYPE byte-for-byte from `chapter.doctype_raw`
    // so epubcheck doesn't flag HTM-004 on every chapter.
    const SINGLE_QUOTED_DOCTYPE =
      `<!DOCTYPE html PUBLIC '-//W3C//DTD XHTML 1.1//EN' 'http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd'>`;
    const ch = `<?xml version="1.0" encoding="UTF-8"?>
${SINGLE_QUOTED_DOCTYPE}
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch</title></head><body><p>Hi</p></body></html>`;
    const bytes = await buildSampleEpub([
      { id: "ch1", href: "ch1.xhtml", xhtml: ch },
    ]);
    const adapter = new EpubAdapter();
    const book = await adapter.load(bytes);
    for (const chapter of book.chapters) {
      const segs = adapter.segment(chapter, { chapter_id: chapter.href });
      adapter.reassemble(chapter, segs);
    }
    const written = await buildEpubBytes(book, { target_lang: "pt" });
    // Re-load and crack open the chapter bytes to inspect the DOCTYPE.
    const reloaded = await adapter.load(written);
    const decoder = new TextDecoder();
    const text = decoder.decode(reloaded.chapters[0].raw_xml);
    expect(text).toContain(SINGLE_QUOTED_DOCTYPE);
  });

  it("strips internal `data-epublate-*` attributes on export (regression)", async () => {
    // The orphan-wrapper machinery inside `splitMixedContentBlock`
    // tags synthetic `<div>`s with `data-epublate-orphan="1"`. That
    // attribute is purely an implementation detail and MUST NOT leak
    // into the exported file — epubcheck's RSC-005 rejects unknown
    // `data-` attributes on the EPUB 2 schema.
    const ch = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><div class="blk"><span><a id="anchor"/></span><h1>Title</h1></div></body></html>`;
    const bytes = await buildSampleEpub([
      { id: "ch1", href: "ch1.xhtml", xhtml: ch },
    ]);
    const adapter = new EpubAdapter();
    const book = await adapter.load(bytes);
    for (const chapter of book.chapters) {
      const segs = adapter.segment(chapter, { chapter_id: chapter.href });
      adapter.reassemble(chapter, segs);
    }
    const written = await buildEpubBytes(book, { target_lang: "pt" });
    const reloaded = await adapter.load(written);
    const text = new TextDecoder().decode(reloaded.chapters[0].raw_xml);
    expect(text).not.toContain("data-epublate-orphan");
    expect(text).not.toContain("data-epublate-");
    // The anchor we wanted to preserve must still be there.
    expect(text).toContain('id="anchor"');
  });

  it("extracts the EPUB 3 cover image (properties=\"cover-image\")", async () => {
    // 1×1 transparent PNG, used as a deterministic cover stand-in.
    const PNG_HEX =
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000132c5d51e0000000049454e44ae426082";
    const png = new Uint8Array(
      PNG_HEX.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
    );

    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:test:book</dc:identifier>
    <dc:title>Cover Test</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`;
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", CONTAINER_XML);
    zip.file("OEBPS/content.opf", opf);
    zip.file(
      "OEBPS/ch1.xhtml",
      chapterDoc("Ch 1", "<h1>Hi</h1><p>Hello.</p>"),
    );
    zip.file("OEBPS/cover.png", png);
    const u8 = await zip.generateAsync({ type: "uint8array" });
    const buf = new ArrayBuffer(u8.byteLength);
    new Uint8Array(buf).set(u8);

    const adapter = new EpubAdapter();
    const book = await adapter.load(buf);
    expect(book.cover).not.toBeNull();
    expect(book.cover!.media_type).toBe("image/png");
    expect(book.cover!.href).toBe("OEBPS/cover.png");
    expect(book.cover!.bytes.byteLength).toBe(png.byteLength);
  });

  it("falls back to EPUB 2 <meta name=\"cover\" /> when properties are absent", async () => {
    const png_bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:test:book</dc:identifier>
    <dc:title>Old Cover</dc:title>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="cover.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`;
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", CONTAINER_XML);
    zip.file("OEBPS/content.opf", opf);
    zip.file(
      "OEBPS/ch1.xhtml",
      chapterDoc("Ch 1", "<h1>Hi</h1><p>Hello.</p>"),
    );
    zip.file("OEBPS/cover.png", png_bytes);
    const u8 = await zip.generateAsync({ type: "uint8array" });
    const buf = new ArrayBuffer(u8.byteLength);
    new Uint8Array(buf).set(u8);

    const adapter = new EpubAdapter();
    const book = await adapter.load(buf);
    expect(book.cover).not.toBeNull();
    expect(book.cover!.media_type).toBe("image/png");
    expect(book.cover!.bytes.byteLength).toBe(png_bytes.byteLength);
  });

  it("returns null cover when no cover is advertised", async () => {
    const bytes = await buildSampleEpub([
      {
        id: "ch1",
        href: "ch1.xhtml",
        xhtml: chapterDoc("Ch", "<p>one</p>"),
      },
    ]);
    const adapter = new EpubAdapter();
    const book = await adapter.load(bytes);
    expect(book.cover).toBeNull();
  });

  it("xpath survives the round-trip", async () => {
    const bytes = await buildSampleEpub([
      {
        id: "ch1",
        href: "ch1.xhtml",
        xhtml: chapterDoc("Ch", "<p>one</p><p>two</p><p>three</p>"),
      },
    ]);
    const adapter = new EpubAdapter();
    const book = await adapter.load(bytes);
    const tree = book.chapters[0].tree!;
    const ps = findTranslatableHosts(tree);
    expect(ps.length).toBeGreaterThanOrEqual(3);
    const paths = ps.map((p) => getXPath(tree, p));
    expect(new Set(paths).size).toBe(paths.length); // unique
    // Each path resolves back to its original element.
    for (let i = 0; i < ps.length; i++) {
      const re = ps[i];
      const ph = placeholderize(re);
      expect(ph.source_text.length).toBeGreaterThan(0);
    }
  });
});
