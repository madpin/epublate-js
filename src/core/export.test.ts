import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildTranslatedEpub,
  buildTranslatedEpubBytes,
  suggestTranslatedFilename,
} from "@/core/export";
import { translateSegment } from "@/core/pipeline";
import { runProjectIntake } from "@/core/project_intake";
import { listChapters } from "@/db/repo/chapters";
import { createProject, deleteProject } from "@/db/repo/projects";
import { listSegmentsForChapter } from "@/db/repo/segments";
import { MockProvider } from "@/llm/mock";

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
    <dc:title>Export Test</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`;

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>One</title></head>
  <body>
    <p>Hello world.</p>
    <p>Second paragraph.</p>
  </body>
</html>`;

async function makeTestEpub(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file("OEBPS/content.opf", OPF);
  zip.file("OEBPS/ch1.xhtml", CH1);
  const u8 = await zip.generateAsync({ type: "uint8array" });
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

describe("buildTranslatedEpub", () => {
  let projectId: string | null = null;

  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("falls back to source text on un-translated segments", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Export Test",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "export.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "export.epub",
    });

    const blob = await buildTranslatedEpub(project.id);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);

    // Round-trip: zip should still parse and contain the original
    // chapter prose since nothing was translated. We use the bytes
    // variant in tests because jsdom's Blob#arrayBuffer is missing.
    const u8 = await buildTranslatedEpubBytes(project.id);
    const zip = await JSZip.loadAsync(u8);
    const ch1 = await zip.file("OEBPS/ch1.xhtml")!.async("string");
    expect(ch1).toContain("Hello world.");
    expect(ch1).toContain("Second paragraph.");
  });

  it("substitutes translated text for translated segments", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Export Test 2",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "export2.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "export2.epub",
    });

    const chapters = await listChapters(project.id);
    const segs = await listSegmentsForChapter(project.id, chapters[0].id);
    const provider = new MockProvider();
    for (const seg of segs) {
      await translateSegment({
        project_id: project.id,
        source_lang: project.source_lang,
        target_lang: project.target_lang,
        style_guide: null,
        segment: seg,
        provider,
        options: { model: "mock-model" },
      });
    }

    const u8 = await buildTranslatedEpubBytes(project.id);
    const zip = await JSZip.loadAsync(u8);
    const ch1 = await zip.file("OEBPS/ch1.xhtml")!.async("string");
    // MockProvider prepends "[mock-tr]" — every translated paragraph
    // should now carry that marker, and the OPF metadata should
    // advertise the target language.
    const matches = ch1.match(/\[mock-tr\]/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(ch1).toContain('lang="pt"');
  });

  it("suggestTranslatedFilename produces a sane default", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Filename Test",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "Witcher Saga (final).epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    const filename = await suggestTranslatedFilename(project.id);
    expect(filename).toMatch(/\.pt\.epub$/);
    expect(filename).not.toMatch(/[() ]/);
  });
});
