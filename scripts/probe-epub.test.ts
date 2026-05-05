/**
 * Diagnostic probe — NOT run in CI. Builds a representative ePub3 in
 * memory, round-trips it through `EpubAdapter.load → segment →
 * reassemble → buildEpubBytes`, dumps both the input and output bytes
 * to /tmp so an external `epubcheck` run can validate them.
 *
 * Run with `npx vitest run scripts/probe-epub.test.ts`.
 */

import { writeFileSync } from "node:fs";
import JSZip from "jszip";
import { describe, it } from "vitest";

import { EpubAdapter } from "@/formats/epub";
import { buildEpubBytes } from "@/formats/epub/writer";

const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:test:roundtrip</dc:identifier>
    <dc:title>Round-trip Smoke Test</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>EPUBLATE Tests</dc:creator>
    <meta property="dcterms:modified">2026-05-04T22:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="nav"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
  <head><title>Contents</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
  <body>
    <nav epub:type="toc" id="toc"><h1>Contents</h1>
      <ol>
        <li><a href="ch1.xhtml">Chapter 1</a></li>
        <li><a href="ch2.xhtml">Chapter 2</a></li>
      </ol>
    </nav>
  </body>
</html>`;

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:test:roundtrip"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>Round-trip Smoke Test</text></docTitle>
  <navMap>
    <navPoint id="navp1" playOrder="1"><navLabel><text>Chapter 1</text></navLabel><content src="ch1.xhtml"/></navPoint>
    <navPoint id="navp2" playOrder="2"><navLabel><text>Chapter 2</text></navLabel><content src="ch2.xhtml"/></navPoint>
  </navMap>
</ncx>`;

const CSS = `body { font-family: serif; }
p { margin: 0.5em 0; }
`;

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
  <head><title>Chapter 1</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
  <body>
    <h1>Chapter 1</h1>
    <p>Hello world. This is a paragraph with <em>emphasis</em>, a <a href="#">link</a>, and a non-breaking&#160;space.</p>
    <p>Line one<br/>Line two.</p>
    <!-- comment that should round-trip -->
  </body>
</html>`;

const CH2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
  <head><title>Chapter 2</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
  <body>
    <h1>Chapter 2</h1>
    <p>Curly &#8220;quotes&#8221; and an em&#8212;dash.</p>
    <p>Another paragraph &#8212; the end.</p>
  </body>
</html>`;

// ePub 2.0.1 fixture: DOCTYPE, NCX, no nav.xhtml, named entities,
// a CSS file, an image, a font.
const OPF_2 = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="bookid" opf:scheme="UUID">urn:test:roundtrip2</dc:identifier>
    <dc:title>EPUB 2 Smoke Test</dc:title>
    <dc:language>en</dc:language>
    <dc:creator opf:role="aut">Test Author</dc:creator>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover" href="cover.png" media-type="image/png"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

const NCX_2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:test:roundtrip2"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>EPUB 2 Smoke Test</text></docTitle>
  <navMap>
    <navPoint id="navp1" playOrder="1"><navLabel><text>Chapter 1</text></navLabel><content src="ch1.xhtml"/></navPoint>
    <navPoint id="navp2" playOrder="2"><navLabel><text>Chapter 2</text></navLabel><content src="ch2.xhtml"/></navPoint>
  </navMap>
</ncx>`;

const CH1_2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
  <head><title>Chapter 1</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
  <body>
    <h1>Chapter 1</h1>
    <p>This paragraph has &nbsp;named entities, &mdash; em-dash, &hellip;ellipsis,
       &ldquo;quotes&rdquo; and an &amp; ampersand.</p>
    <p>Line one<br/>Line two with <em>emphasis</em>.</p>
  </body>
</html>`;

const CH2_2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
  <head><title>Chapter 2</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
  <body>
    <h1>Chapter 2</h1>
    <p>The end &mdash; goodbye.</p>
  </body>
</html>`;

// 1x1 transparent PNG.
const COVER_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==";

function pngBytes(): Uint8Array {
  const bin = atob(COVER_PNG_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe("epubcheck probe", () => {
  it("epub3: dumps /tmp/input.epub + /tmp/output.epub", async () => {
    const inputZip = new JSZip();
    inputZip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    inputZip.file("META-INF/container.xml", CONTAINER_XML);
    inputZip.file("OEBPS/content.opf", OPF);
    inputZip.file("OEBPS/nav.xhtml", NAV);
    inputZip.file("OEBPS/toc.ncx", NCX);
    inputZip.file("OEBPS/style.css", CSS);
    inputZip.file("OEBPS/ch1.xhtml", CH1);
    inputZip.file("OEBPS/ch2.xhtml", CH2);
    const inputBytes = await inputZip.generateAsync({ type: "uint8array" });
    writeFileSync("/tmp/input.epub", inputBytes);

    const adapter = new EpubAdapter();
    const buf = new ArrayBuffer(inputBytes.byteLength);
    new Uint8Array(buf).set(inputBytes);
    const book = await adapter.load(buf, { filename: "roundtrip.epub" });
    for (const ch of book.chapters) {
      const segs = adapter.segment(ch, { chapter_id: ch.href });
      adapter.reassemble(ch, segs);
    }
    const out = await buildEpubBytes(book, {
      target_lang: "pt",
      provenance: "epublate-js",
    });
    writeFileSync("/tmp/output.epub", out);
  });

  for (const fixture of [
    { in: "/tmp/gutenberg.epub", out: "/tmp/output_gutenberg.epub" },
    { in: "/tmp/frankenstein.epub", out: "/tmp/output_frankenstein.epub" },
    { in: "/tmp/alice.epub", out: "/tmp/output_alice.epub" },
  ]) {
    it(`real-world: round-trips ${fixture.in}`, async () => {
      let inputBytes: Uint8Array;
      try {
        const fs = await import("node:fs");
        inputBytes = new Uint8Array(fs.readFileSync(fixture.in));
      } catch {
        return;
      }
      const adapter = new EpubAdapter();
      const buf = new ArrayBuffer(inputBytes.byteLength);
      new Uint8Array(buf).set(inputBytes);
      const book = await adapter.load(buf, { filename: fixture.in });
      for (const ch of book.chapters) {
        const segs = adapter.segment(ch, { chapter_id: ch.href });
        adapter.reassemble(ch, segs);
      }
      const out = await buildEpubBytes(book, {
        target_lang: "pt",
        provenance: "epublate-js",
      });
      writeFileSync(fixture.out, out);
    });
  }

  it("epub2: dumps /tmp/input2.epub + /tmp/output2.epub", async () => {
    const inputZip = new JSZip();
    inputZip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    inputZip.file("META-INF/container.xml", CONTAINER_XML);
    inputZip.file("OEBPS/content.opf", OPF_2);
    inputZip.file("OEBPS/toc.ncx", NCX_2);
    inputZip.file("OEBPS/style.css", CSS);
    inputZip.file("OEBPS/cover.png", pngBytes());
    inputZip.file("OEBPS/ch1.xhtml", CH1_2);
    inputZip.file("OEBPS/ch2.xhtml", CH2_2);
    const inputBytes = await inputZip.generateAsync({ type: "uint8array" });
    writeFileSync("/tmp/input2.epub", inputBytes);

    const adapter = new EpubAdapter();
    const buf = new ArrayBuffer(inputBytes.byteLength);
    new Uint8Array(buf).set(inputBytes);
    const book = await adapter.load(buf, { filename: "roundtrip2.epub" });
    for (const ch of book.chapters) {
      const segs = adapter.segment(ch, { chapter_id: ch.href });
      adapter.reassemble(ch, segs);
    }
    const out = await buildEpubBytes(book, {
      target_lang: "pt",
      provenance: "epublate-js",
    });
    writeFileSync("/tmp/output2.epub", out);
  });
});
