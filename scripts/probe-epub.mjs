// Build a "real-world" epub3 sample that exercises the corner cases
// epubcheck cares about, run it through our load → reassemble → write
// pipeline, and dump the result for `epubcheck` to grade.

import { writeFileSync } from "node:fs";
import JSZip from "jszip";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.Element = dom.window.Element;
globalThis.Document = dom.window.Document;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { EpubAdapter } = await import(
  "/Users/tpinto/madpin/epublatejs/src/formats/epub/index.ts"
);
const { buildEpubBytes } = await import(
  "/Users/tpinto/madpin/epublatejs/src/formats/epub/writer.ts"
);

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
  <head><title>Contents</title><link rel="stylesheet" href="style.css"/></head>
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
p { margin: 0.5em 0; }`;

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
  <head><title>Chapter 1</title><link rel="stylesheet" href="style.css"/></head>
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
  <head><title>Chapter 2</title><link rel="stylesheet" href="style.css"/></head>
  <body>
    <h1>Chapter 2</h1>
    <p>Curly &#8220;quotes&#8221; and an em&#8212;dash.</p>
    <p>Another paragraph &#8212; the end.</p>
  </body>
</html>`;

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
const book = await adapter.load(
  Uint8Array.from(inputBytes).buffer,
  { filename: "roundtrip.epub" },
);
for (const ch of book.chapters) {
  const segs = adapter.segment(ch, { chapter_id: ch.href });
  adapter.reassemble(ch, segs);
}
const out = await buildEpubBytes(book, {
  target_lang: "pt",
  provenance: "epublate-js",
});
writeFileSync("/tmp/output.epub", out);
console.log("input  :", inputBytes.byteLength, "bytes");
console.log("output :", out.byteLength, "bytes");
