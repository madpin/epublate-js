import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { createProject, deleteProject } from "@/db/repo/projects";
import { listChapters } from "@/db/repo/chapters";
import { countSegments, listSegmentsForChapter } from "@/db/repo/segments";

import { runProjectIntake } from "./project_intake";

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
    <dc:title>Intake Test</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>One</title></head>
  <body>
    <h1>Chapter One</h1>
    <p>The first paragraph of prose.</p>
    <p>And a second paragraph with <em>emphasis</em>.</p>
  </body>
</html>`;

const CH2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Two</title></head>
  <body>
    <h2>Chapter Two</h2>
    <p>Only one paragraph here.</p>
  </body>
</html>`;

async function makeTestEpub(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file("OEBPS/content.opf", OPF);
  zip.file("OEBPS/ch1.xhtml", CH1);
  zip.file("OEBPS/ch2.xhtml", CH2);
  const u8 = await zip.generateAsync({ type: "uint8array" });
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

describe("runProjectIntake", () => {
  let projectId: string | null = null;

  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("imports chapters and segments from a synthetic ePub", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Intake Test",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "intake.epub",
      source_bytes: bytes,
    });
    projectId = project.id;

    const result = await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "intake.epub",
    });

    expect(result.chapters).toBe(2);
    // h1+2p in ch1, h2+1p in ch2 = 5 segments
    expect(result.segments).toBe(5);

    const chapters = await listChapters(project.id);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].spine_idx).toBe(0);
    expect(chapters[1].spine_idx).toBe(1);

    const ch1Segs = await listSegmentsForChapter(project.id, chapters[0].id);
    expect(ch1Segs).toHaveLength(3);
    expect(ch1Segs[0].source_text).toContain("Chapter One");
    expect(ch1Segs[1].source_text).toContain("first paragraph");

    // Skeleton + host path round-trip through the envelope encoding.
    const segWithEm = ch1Segs[2];
    expect(segWithEm.inline_skeleton.length).toBeGreaterThan(0);
    expect(segWithEm.host_path).toMatch(/^\/.+/);

    const total = await countSegments(project.id);
    expect(total).toBe(5);
  });
});
