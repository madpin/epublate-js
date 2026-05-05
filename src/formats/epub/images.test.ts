import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadEpub } from "./loader";
import {
  buildChapterImageMap,
  findStandaloneImages,
  loadChapterAssets,
  revokeAll,
} from "./images";
import type { InlineToken } from "./types";

const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:test:book</dc:identifier>
    <dc:title>Image test</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="images/cover.jpg" media-type="image/jpeg"/>
    <item id="img2" href="images/figure-1.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`;

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Ch.1</title></head>
  <body>
    <p>Some narration before the figure.</p>
    <p><img src="images/figure-1.png" alt="Figure 1"/></p>
    <p>And the prose continues with an inline <img src="images/cover.jpg" alt="Cover"/> nudge.</p>
  </body>
</html>`;

async function makeEpub(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file("OEBPS/content.opf", OPF);
  zip.file("OEBPS/ch1.xhtml", CH1);
  // Tiny "image" payloads — content doesn't matter for this test;
  // we just need *some* bytes to mint object URLs from.
  zip.file("OEBPS/images/cover.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
  zip.file(
    "OEBPS/images/figure-1.png",
    new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  );
  const u8 = await zip.generateAsync({ type: "uint8array" });
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

describe("findStandaloneImages", () => {
  it("returns image-only paragraphs but skips images that already live inside a translatable host", async () => {
    const bytes = await makeEpub();
    const book = await loadEpub(bytes);
    const chapter = book.chapters[0]!;
    const found = findStandaloneImages(chapter);
    // Only the image-only `<p>` survives. The cover.jpg lives inside
    // a paragraph with translatable text, so the segmenter encoded it
    // as an inline-skeleton token; surfacing it here as well would
    // double-render it in the Reader.
    expect(found.map((i) => i.resolved)).toEqual([
      "OEBPS/images/figure-1.png",
    ]);
    // The image lands *between* the first and second translatable
    // paragraph, so its splice point is `1` (one host preceded it).
    expect(found[0]!.splice_at).toBe(1);
  });

  it("places a leading illustration before the first segment", async () => {
    const TOP_OF_CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Ch.1</title></head>
  <body>
    <figure><img src="images/figure-1.png" alt="Frontispiece"/></figure>
    <p>The first prose paragraph.</p>
    <p>Then a second one.</p>
  </body>
</html>`;
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", CONTAINER_XML);
    zip.file("OEBPS/content.opf", OPF);
    zip.file("OEBPS/ch1.xhtml", TOP_OF_CHAPTER);
    zip.file("OEBPS/images/cover.jpg", new Uint8Array([0xff]));
    zip.file("OEBPS/images/figure-1.png", new Uint8Array([0x89]));
    const u8 = await zip.generateAsync({ type: "uint8array" });
    const buf = new ArrayBuffer(u8.byteLength);
    new Uint8Array(buf).set(u8);
    const book = await loadEpub(buf);
    const found = findStandaloneImages(book.chapters[0]!);
    expect(found).toHaveLength(1);
    expect(found[0]!.splice_at).toBe(0);
    expect(found[0]!.alt).toBe("Frontispiece");
  });

  it("places a trailing illustration after the last segment", async () => {
    const END_OF_CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Ch.1</title></head>
  <body>
    <p>Opening line.</p>
    <p>Closing line.</p>
    <div><img src="images/figure-1.png" alt="Tailpiece"/></div>
  </body>
</html>`;
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", CONTAINER_XML);
    zip.file("OEBPS/content.opf", OPF);
    zip.file("OEBPS/ch1.xhtml", END_OF_CHAPTER);
    zip.file("OEBPS/images/cover.jpg", new Uint8Array([0xff]));
    zip.file("OEBPS/images/figure-1.png", new Uint8Array([0x89]));
    const u8 = await zip.generateAsync({ type: "uint8array" });
    const buf = new ArrayBuffer(u8.byteLength);
    new Uint8Array(buf).set(u8);
    const book = await loadEpub(buf);
    const found = findStandaloneImages(book.chapters[0]!);
    expect(found).toHaveLength(1);
    expect(found[0]!.splice_at).toBe(2);
  });
});

describe("buildChapterImageMap", () => {
  // jsdom doesn't ship `URL.createObjectURL` at the time of writing
  // (https://github.com/jsdom/jsdom/issues/1721). Stub it out so the
  // tests can verify call patterns without dragging in the polyfill.
  let create_calls: number;
  let revoke_calls: number;
  let original_create:
    | typeof URL.createObjectURL
    | undefined;
  let original_revoke:
    | typeof URL.revokeObjectURL
    | undefined;

  beforeEach(() => {
    create_calls = 0;
    revoke_calls = 0;
    original_create = URL.createObjectURL;
    original_revoke = URL.revokeObjectURL;
    URL.createObjectURL = ((blob: Blob | MediaSource): string => {
      create_calls += 1;
      const type = "type" in blob ? blob.type : "";
      return `blob:fake/${type}`;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((_: string): void => {
      revoke_calls += 1;
    }) as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    if (original_create) URL.createObjectURL = original_create;
    else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    if (original_revoke) URL.revokeObjectURL = original_revoke;
    else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it("resolves every distinct image src once and reuses the same object URL", async () => {
    const bytes = await makeEpub();
    const book = await loadEpub(bytes);
    const chapter = book.chapters[0]!;

    const skeletons: InlineToken[][] = [
      [
        // First segment references an image directly.
        {
          tag: "img",
          kind: "void",
          attrs: { src: "images/figure-1.png", alt: "Figure 1" },
        },
      ],
      [
        // Second segment references the same image again — must hit
        // the byResolved cache (no second createObjectURL).
        {
          tag: "img",
          kind: "void",
          attrs: { src: "images/figure-1.png", alt: "Figure 1" },
        },
        {
          tag: "img",
          kind: "void",
          attrs: { src: "images/cover.jpg", alt: "Cover" },
        },
      ],
    ];

    const map = buildChapterImageMap(book, chapter, skeletons);

    expect(map.byRawSrc.get("images/figure-1.png")).toBe(
      "blob:fake/image/png",
    );
    expect(map.byRawSrc.get("images/cover.jpg")).toBe("blob:fake/image/jpeg");
    expect(map.urls).toHaveLength(2);
    expect(create_calls).toBe(2);

    revokeAll(map);
    expect(revoke_calls).toBe(2);
    expect(map.byRawSrc.size).toBe(0);
    expect(map.urls).toHaveLength(0);
  });

  it("returns null for unresolvable / external sources", async () => {
    const bytes = await makeEpub();
    const book = await loadEpub(bytes);
    const chapter = book.chapters[0]!;

    const skeletons: InlineToken[][] = [
      [
        {
          tag: "img",
          kind: "void",
          attrs: { src: "https://example.com/external.png" },
        },
        {
          tag: "img",
          kind: "void",
          attrs: { src: "images/missing.gif" },
        },
        {
          tag: "img",
          kind: "void",
          attrs: { src: "data:image/png;base64,AAA" },
        },
      ],
    ];
    const map = buildChapterImageMap(book, chapter, skeletons);
    expect(map.byRawSrc.get("https://example.com/external.png")).toBeNull();
    expect(map.byRawSrc.get("images/missing.gif")).toBeNull();
    expect(map.byRawSrc.get("data:image/png;base64,AAA")).toBeNull();
    expect(map.urls).toHaveLength(0);
  });
});

describe("loadChapterAssets", () => {
  it("loads the book and returns the chapter matching the href", async () => {
    const bytes = await makeEpub();
    const result = await loadChapterAssets(bytes, "OEBPS/ch1.xhtml");
    expect(result).not.toBeNull();
    expect(result!.chapter.href).toBe("OEBPS/ch1.xhtml");
    expect(result!.book.spine_hrefs).toContain("OEBPS/ch1.xhtml");
  });

  it("returns null when the chapter href does not exist", async () => {
    const bytes = await makeEpub();
    const result = await loadChapterAssets(bytes, "OEBPS/missing.xhtml");
    expect(result).toBeNull();
  });
});
