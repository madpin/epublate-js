import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProject, deleteProject } from "@/db/repo/projects";
import { listChapters } from "@/db/repo/chapters";
import { openProjectDb } from "@/db/dexie";
import { runProjectIntake } from "@/core/project_intake";
import { runBatch, BatchPaused } from "@/core/batch";
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
    <dc:title>Batch Test</dc:title>
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
    <p>The first paragraph.</p>
    <p>And a second paragraph.</p>
  </body>
</html>`;

const CH2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Two</title></head>
  <body>
    <p>Chapter two opens.</p>
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

describe("runBatch", () => {
  let projectId: string | null = null;

  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("translates every pending segment and records counts", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Batch",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "b.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "b.epub",
    });

    const provider = new MockProvider();
    const summary = await runBatch({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      provider,
      options: { model: "mock-model", concurrency: 2 },
    });

    expect(summary.total).toBeGreaterThanOrEqual(3);
    expect(summary.translated).toBeGreaterThanOrEqual(3);
    expect(summary.failed).toBe(0);
    expect(summary.elapsed_s).toBeGreaterThanOrEqual(0);

    // Re-run: every prior call is now cached, and the budget is fresh.
    const second = await runBatch({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      provider,
      options: { model: "mock-model" },
    });
    // Already-translated segments are no longer pending, so the second
    // run is a no-op.
    expect(second.total).toBe(0);
    expect(second.translated).toBe(0);
  });

  it("pauses on the budget cap and throws BatchPaused", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Budget",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "g.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "g.epub",
    });

    // Force every call to "cost" something via a priced model + non-zero token usage.
    const provider = new MockProvider();
    vi.spyOn(provider, "chat").mockImplementation(async () => ({
      content: '{"target":"[paid]","used_entries":[],"new_entities":[]}',
      usage: {
        prompt_tokens: 100_000,
        completion_tokens: 100_000,
        total_tokens: 200_000,
      },
      model: "gpt-4-turbo",
      cache_hit: false,
      raw: null,
    }));

    let threw: BatchPaused | null = null;
    try {
      await runBatch({
        project_id: project.id,
        source_lang: "en",
        target_lang: "pt",
        provider,
        // gpt-4-turbo: 100k input + 100k output = $1.00 + $3.00 = $4.00 per call
        options: { model: "gpt-4-turbo", budget_usd: 1, concurrency: 1 },
      });
    } catch (err: unknown) {
      if (err instanceof BatchPaused) threw = err;
      else throw err;
    }
    expect(threw).not.toBeNull();
    expect(threw!.summary.cost_usd).toBeGreaterThanOrEqual(1);
    expect(threw!.summary.paused_reason).toMatch(/budget cap/);
  });

  it("isolates per-segment failures and continues", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Failure",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "f.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "f.epub",
    });

    const provider = new MockProvider();
    let n = 0;
    vi.spyOn(provider, "chat").mockImplementation(async (input) => {
      n += 1;
      if (n === 2) throw new Error("boom on second call");
      const real = new MockProvider();
      return real.chat(input);
    });

    const summary = await runBatch({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      provider,
      options: { model: "mock-model", concurrency: 1 },
    });

    expect(summary.failed).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].error).toMatch(/boom/);
    expect(summary.translated).toBeGreaterThanOrEqual(2);

    // The runner should have written a `batch.segment_failed` event.
    const db = openProjectDb(project.id);
    const events = await db.events.toArray();
    const fail_evt = events.filter((e) => e.kind === "batch.segment_failed");
    expect(fail_evt.length).toBeGreaterThanOrEqual(1);
  });

  it("fires on_segment_start before each translateSegment and on_segment_end after", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Lifecycle",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "lc.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "lc.epub",
    });

    const provider = new MockProvider();
    const events: { kind: "start" | "end"; segment_id: string }[] = [];
    await runBatch({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      provider,
      options: { model: "mock-model", concurrency: 1 },
      on_segment_start: ({ segment_id }) =>
        events.push({ kind: "start", segment_id }),
      on_segment_end: ({ segment_id }) =>
        events.push({ kind: "end", segment_id }),
    });

    // Each segment must produce exactly one start + one end, in that order
    // (concurrency=1 keeps them strictly interleaved).
    expect(events.length).toBeGreaterThan(0);
    expect(events.length % 2).toBe(0);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i].kind).toBe("start");
      expect(events[i + 1].kind).toBe("end");
      expect(events[i].segment_id).toBe(events[i + 1].segment_id);
    }
  });

  it("filters by chapter_ids", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Filter",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "x.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "x.epub",
    });

    const chapters = await listChapters(project.id);
    const ch1 = chapters[0];

    const provider = new MockProvider();
    const summary = await runBatch({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      provider,
      options: {
        model: "mock-model",
        chapter_ids: [ch1.id],
      },
    });

    // Only the segments inside the first chapter should be in scope.
    expect(summary.total).toBeGreaterThanOrEqual(2);
    const db = openProjectDb(project.id);
    const segs2 = await db.segments
      .where("chapter_id")
      .equals(chapters[1]!.id)
      .toArray();
    for (const s of segs2) {
      expect(s.target_text).toBeNull();
    }
  });
});
