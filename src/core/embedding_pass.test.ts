import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { createProject, deleteProject } from "@/db/repo/projects";
import { listSegmentsForChapter } from "@/db/repo/segments";
import { listChapters } from "@/db/repo/chapters";
import { runProjectIntake } from "@/core/project_intake";
import { runEmbeddingPass } from "@/core/embedding_pass";
import { listEmbeddingsByScope } from "@/db/repo/embeddings";
import { listIntakeRuns } from "@/db/repo/intake";
import { IntakeRunKind, IntakeRunStatus } from "@/db/schema";
import { MockEmbeddingProvider } from "@/llm/embeddings/mock";

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
    <dc:title>Embedding Pass Test</dc:title>
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
    <p>Lorem ipsum dolor sit amet.</p>
    <p>Consectetur adipiscing elit.</p>
    <p>Sed do eiusmod tempor incididunt.</p>
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

describe("runEmbeddingPass", () => {
  let projectId: string | null = null;

  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("embeds every segment in the project and records an intake_run", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "EmbPass",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "e.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "e.epub",
    });

    const provider = new MockEmbeddingProvider({ dim: 32 });
    const summary = await runEmbeddingPass(project.id, provider);

    const chapters = await listChapters(project.id);
    const segs = await listSegmentsForChapter(project.id, chapters[0]!.id);
    expect(summary.embedded).toBe(segs.length);
    expect(summary.status).toBe("completed");
    expect(summary.batches).toBeGreaterThan(0);

    // Every embedded vector must be available via the repo.
    const stored = await listEmbeddingsByScope(
      "project",
      project.id,
      "segment",
      provider.model,
    );
    expect(stored.length).toBe(segs.length);

    // The intake run shows up on the runs list with the new kind.
    const runs = await listIntakeRuns(project.id, {
      kind: IntakeRunKind.EMBEDDING_PASS,
    });
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe(IntakeRunStatus.COMPLETED);
    expect(runs[0]!.proposed_count).toBe(segs.length);
  });

  it("is idempotent: a second pass embeds 0 new segments", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "EmbPass idempotent",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "e2.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "e2.epub",
    });

    const provider = new MockEmbeddingProvider({ dim: 32 });
    const first = await runEmbeddingPass(project.id, provider);
    expect(first.embedded).toBeGreaterThan(0);

    const second = await runEmbeddingPass(project.id, provider);
    expect(second.embedded).toBe(0);
    expect(second.batches).toBe(0);
    expect(second.status).toBe("completed");
  });

  it("runs as part of intake when an embedding provider is supplied", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Intake emb",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "i.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    const provider = new MockEmbeddingProvider({ dim: 32 });
    const result = await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "i.epub",
      embedding_pass: { provider },
    });

    expect(result.embedded_segments).toBeGreaterThan(0);
    expect(result.embedded_segments).toBe(result.segments);
  });
});
