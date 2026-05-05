import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProject, deleteProject } from "@/db/repo/projects";
import {
  countSegments,
  listSegmentsForChapter,
  rowToSegment,
} from "@/db/repo/segments";
import { listChapters } from "@/db/repo/chapters";
import { openProjectDb } from "@/db/dexie";
import { SegmentStatus } from "@/db/schema";
import { runProjectIntake } from "@/core/project_intake";
import { translateSegment } from "@/core/pipeline";
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
    <dc:title>Pipeline Test</dc:title>
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
    <p>The first paragraph.</p>
    <p>And a second paragraph with <em>emphasis</em>.</p>
    <p>   </p>
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

describe("translateSegment", () => {
  let projectId: string | null = null;

  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("translates one segment with the mock provider and persists target_text", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Pipeline",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "p.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "p.epub",
    });

    const chapters = await listChapters(project.id);
    const segs = await listSegmentsForChapter(project.id, chapters[0].id);
    const target = segs.find((s) => s.source_text.includes("first paragraph"));
    expect(target).toBeTruthy();

    const provider = new MockProvider();
    const out = await translateSegment({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      style_guide: null,
      segment: target!,
      provider,
      options: { model: "mock-model" },
    });

    expect(out.cache_hit).toBe(false);
    expect(out.trivial).toBe(false);
    expect(out.target_text).toContain("[mock-tr]");
    expect(out.cost_usd).toBeGreaterThanOrEqual(0);
    expect(out.llm_call_id).toBeTruthy();

    const db = openProjectDb(project.id);
    const row = await db.segments.get(target!.id);
    expect(row?.status).toBe(SegmentStatus.TRANSLATED);
    expect(row?.target_text).toContain("[mock-tr]");

    const calls = await db.llm_calls
      .where("segment_id")
      .equals(target!.id)
      .toArray();
    expect(calls).toHaveLength(1);
    expect(calls[0].cache_hit).toBe(0);
    expect(calls[0].cache_key).toBe(out.cache_key);

    const total = await countSegments(project.id);
    expect(total).toBeGreaterThan(0);
  });

  it("re-uses the cache on a second translate call", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Cache",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "c.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "c.epub",
    });

    const chapters = await listChapters(project.id);
    const segs = await listSegmentsForChapter(project.id, chapters[0].id);
    const target = segs.find((s) => s.source_text.includes("first paragraph"))!;

    const provider = new MockProvider();
    const spy = vi.spyOn(provider, "chat");

    const first = await translateSegment({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      style_guide: null,
      segment: target,
      provider,
      options: { model: "mock-model" },
    });
    expect(first.cache_hit).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);

    const db = openProjectDb(project.id);
    const reloaded = rowToSegment((await db.segments.get(target.id))!);

    const second = await translateSegment({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      style_guide: null,
      segment: reloaded,
      provider,
      options: { model: "mock-model" },
    });
    expect(second.cache_hit).toBe(true);
    expect(second.target_text).toBe(first.target_text);
    expect(spy).toHaveBeenCalledTimes(1); // no new provider call
  });

  it("logs the introducing segment in entity_mentions for auto-proposed entries", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "First sighting",
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

    const chapters = await listChapters(project.id);
    const segs = await listSegmentsForChapter(project.id, chapters[0].id);
    const target = segs.find((s) => s.source_text.includes("first paragraph"))!;

    // Custom provider that proposes a brand-new character on this
    // very segment. The pipeline must see that, persist the entry,
    // and then record an `entity_mention` on this segment so the
    // entry's "occurrences" page does not start at chapter 2.
    const provider = new MockProvider();
    vi.spyOn(provider, "chat").mockResolvedValue({
      content: JSON.stringify({
        target: "[mock-tr] Conheça Eira Stoneblood, a primeira frase.",
        used_entries: [],
        new_entities: [
          {
            type: "character",
            source: "first paragraph",
            target: "primeira frase",
            evidence: "ch.1 introduction",
          },
        ],
        notes: null,
      }),
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      model: "mock-model",
      cache_hit: false,
      raw: { mock: true },
    });

    await translateSegment({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      style_guide: null,
      segment: target,
      provider,
      options: { model: "mock-model" },
    });

    const db = openProjectDb(project.id);
    const entries = await db.glossary_entries
      .where("project_id")
      .equals(project.id)
      .toArray();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.first_seen_segment_id).toBe(target.id);
    const mentions = await db.entity_mentions
      .where("entry_id")
      .equals(entry.id)
      .toArray();
    expect(mentions.map((m) => m.segment_id)).toContain(target.id);
  });

  it("in dialogue context mode, only injects context for dialogue-looking segments", async () => {
    // Build a tiny chapter with a mix of narration and quoted dialogue
    // so we can verify that:
    //   - narration → no context block (cheap, mode skips entirely)
    //   - dialogue  → context block, but only previously-translated
    //                 dialogue is included (narration is filtered out)
    const dialogueChapter = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Dialogue</title></head>
  <body>
    <p>"Hello there," she said brightly.</p>
    <p>The room was warm and crowded with old books.</p>
    <p>"And how are you today?" he replied.</p>
    <p>She smiled at him without answering.</p>
    <p>"Just thinking," she said at last.</p>
  </body>
</html>`;
    const opf = OPF.replace("ch1.xhtml", "ch1.xhtml");
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", CONTAINER_XML);
    zip.file("OEBPS/content.opf", opf);
    zip.file("OEBPS/ch1.xhtml", dialogueChapter);
    const u8 = await zip.generateAsync({ type: "uint8array" });
    const dialogueBytes = new ArrayBuffer(u8.byteLength);
    new Uint8Array(dialogueBytes).set(u8);

    const project = await createProject({
      name: "Dialogue ctx",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "d.epub",
      source_bytes: dialogueBytes,
      context_max_segments: 4,
      context_max_chars: 0,
      context_mode: "dialogue",
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: dialogueBytes,
      source_filename: "d.epub",
    });

    const chapters = await listChapters(project.id);
    const segs = await listSegmentsForChapter(project.id, chapters[0].id);
    expect(segs.length).toBeGreaterThanOrEqual(5);

    // Translate every segment in order with the mock provider.
    const provider = new MockProvider();
    const chatSpy = vi.spyOn(provider, "chat");

    for (const seg of segs.slice(0, 4)) {
      await translateSegment({
        project_id: project.id,
        source_lang: "en",
        target_lang: "pt",
        style_guide: null,
        segment: seg,
        provider,
        options: { model: "mock-model" },
      });
    }

    // 5th segment is dialogue: "Just thinking,". Capture its prompt so
    // we can inspect the context block that was injected.
    chatSpy.mockClear();
    await translateSegment({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      style_guide: null,
      segment: segs[4],
      provider,
      options: { model: "mock-model" },
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    const sysMsg = chatSpy.mock.calls[0]![0]!.messages.find(
      (m) => m.role === "system",
    )!;
    const sysContent =
      typeof sysMsg.content === "string"
        ? sysMsg.content
        : JSON.stringify(sysMsg.content);
    // The context block must mention dialogue lines and not the
    // narrative prose between them.
    expect(sysContent).toContain("Preceding segments");
    expect(sysContent).toContain("Hello there");
    expect(sysContent).toContain("how are you today");
    expect(sysContent).not.toContain("warm and crowded");
    expect(sysContent).not.toContain("smiled at him");
  });

  it("in dialogue context mode, narration segments translate with no context block", async () => {
    const dialogueChapter = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Dialogue</title></head>
  <body>
    <p>"Hello there," she said brightly.</p>
    <p>The room was warm and crowded with old books.</p>
  </body>
</html>`;
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", CONTAINER_XML);
    zip.file("OEBPS/content.opf", OPF);
    zip.file("OEBPS/ch1.xhtml", dialogueChapter);
    const u8 = await zip.generateAsync({ type: "uint8array" });
    const dialogueBytes = new ArrayBuffer(u8.byteLength);
    new Uint8Array(dialogueBytes).set(u8);

    const project = await createProject({
      name: "Dialogue narr",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "d2.epub",
      source_bytes: dialogueBytes,
      context_max_segments: 4,
      context_mode: "dialogue",
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: dialogueBytes,
      source_filename: "d2.epub",
    });

    const chapters = await listChapters(project.id);
    const segs = await listSegmentsForChapter(project.id, chapters[0].id);

    const provider = new MockProvider();
    // Translate segment 0 (dialogue). Then translate segment 1
    // (narration) and confirm no context block was injected.
    await translateSegment({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      style_guide: null,
      segment: segs[0],
      provider,
      options: { model: "mock-model" },
    });

    const chatSpy = vi.spyOn(provider, "chat");
    await translateSegment({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      style_guide: null,
      segment: segs[1],
      provider,
      options: { model: "mock-model" },
    });

    const sysMsg = chatSpy.mock.calls[0]![0]!.messages.find(
      (m) => m.role === "system",
    )!;
    const sysContent =
      typeof sysMsg.content === "string"
        ? sysMsg.content
        : JSON.stringify(sysMsg.content);

    // Narration must not pick up the dialogue we already translated,
    // and the "Preceding segments" header must not appear at all
    // (cheap path: no context block emitted).
    expect(sysContent).not.toContain("Hello there");
    expect(sysContent).not.toContain("Preceding segments");
  });

  it("short-circuits trivially-empty segments without calling the LLM", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Trivial",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "t.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "t.epub",
    });

    const chapters = await listChapters(project.id);
    const segs = await listSegmentsForChapter(project.id, chapters[0].id);
    // The whitespace-only <p> should have produced a trivially-empty segment.
    const trivial = segs.find((s) => s.source_text.trim() === "");
    if (!trivial) {
      // Some segmentation paths may not emit empty hosts; the test is not
      // applicable in that case.
      return;
    }

    const provider = new MockProvider();
    const spy = vi.spyOn(provider, "chat");
    const out = await translateSegment({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      style_guide: null,
      segment: trivial,
      provider,
      options: { model: "mock-model" },
    });

    expect(out.trivial).toBe(true);
    expect(out.cache_hit).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("injects curator-authored chapter notes into the system prompt", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Notes",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "n.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "n.epub",
    });

    const chapters = await listChapters(project.id);
    const segs = await listSegmentsForChapter(project.id, chapters[0].id);
    const target = segs.find((s) =>
      s.source_text.includes("first paragraph"),
    )!;

    const provider = new MockProvider();
    const spy = vi.spyOn(provider, "chat");

    await translateSegment({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      style_guide: null,
      chapter_notes:
        "POV: first-person, narrator is unreliable.\nUse Portuguese 'tu' for the protagonist.",
      segment: target,
      provider,
      options: { model: "mock-model" },
    });

    const sysMsg = spy.mock.calls[0]![0]!.messages.find(
      (m) => m.role === "system",
    )!;
    const sysContent =
      typeof sysMsg.content === "string"
        ? sysMsg.content
        : JSON.stringify(sysMsg.content);
    expect(sysContent).toContain("Chapter notes");
    expect(sysContent).toContain("unreliable");
    expect(sysContent).toContain("'tu' for the protagonist");
  });

  it("chapter notes change the cache key (notes edits invalidate cache)", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Notes cache",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "n2.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "n2.epub",
    });

    const chapters = await listChapters(project.id);
    const segs = await listSegmentsForChapter(project.id, chapters[0].id);
    const target = segs.find((s) =>
      s.source_text.includes("first paragraph"),
    )!;
    const reload = async () => {
      const db = openProjectDb(project.id);
      return rowToSegment((await db.segments.get(target.id))!);
    };

    const provider = new MockProvider();
    const spy = vi.spyOn(provider, "chat");

    const a = await translateSegment({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      style_guide: null,
      chapter_notes: "Note A",
      segment: target,
      provider,
      options: { model: "mock-model" },
    });
    expect(a.cache_hit).toBe(false);

    // Same notes ⇒ cache hit.
    const b = await translateSegment({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      style_guide: null,
      chapter_notes: "Note A",
      segment: await reload(),
      provider,
      options: { model: "mock-model" },
    });
    expect(b.cache_hit).toBe(true);

    // Notes change ⇒ cache miss.
    spy.mockClear();
    const c = await translateSegment({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      style_guide: null,
      chapter_notes: "Note B",
      segment: await reload(),
      provider,
      options: { model: "mock-model" },
    });
    expect(c.cache_hit).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
