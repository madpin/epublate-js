/**
 * Tests for `core/extractor` — the helper-LLM passes that surface
 * proposed glossary entries and a draft style profile.
 */

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runProjectIntake } from "@/core/project_intake";
import {
  extractEntities,
  runBookIntake,
  runPrePass,
  PURPOSE_EXTRACT,
} from "@/core/extractor";
import { openProjectDb } from "@/db/dexie";
import { listChapters } from "@/db/repo/chapters";
import { listIntakeRuns, listIntakeRunEntries } from "@/db/repo/intake";
import { listGlossaryEntries } from "@/db/repo/glossary";
import { createProject, deleteProject } from "@/db/repo/projects";
import { type ChatRequest, type ChatResult } from "@/llm/base";
import { MockProvider } from "@/llm/mock";
import { type SegmentRow } from "@/db/schema";

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
    <dc:title>Extractor Test</dc:title>
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
    <h1>Chapter One: The Spire</h1>
    <p>Aldric stood before the gates of Eldoria, his sword unsheathed.</p>
    <p>The Council of Five had warned him about the Spire of Whispers.</p>
  </body>
</html>`;

const CH2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Two</title></head>
  <body>
    <h2>Chapter Two: The Pact</h2>
    <p>Lyra of Ashfall waited beneath the Long Night.</p>
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

/** Build a minimal extractor JSON response payload. */
function extractorPayload(
  options: {
    entities?: Array<{
      type: string;
      source: string;
      target?: string | null;
      evidence?: string | null;
      confidence?: number;
    }>;
    pov?: string | null;
    tense?: string | null;
    register?: string | null;
    audience?: string | null;
    notes?: string | null;
  } = {},
): string {
  return JSON.stringify({
    entities: options.entities ?? [],
    pov: options.pov ?? null,
    tense: options.tense ?? null,
    register: options.register ?? null,
    audience: options.audience ?? null,
    notes: options.notes ?? null,
  });
}

/** Build a ChatResult that passes through `parseExtractorResponse`. */
function chatResult(
  content: string,
  options: { model?: string; prompt_tokens?: number; completion_tokens?: number } = {},
): ChatResult {
  return {
    content,
    usage: {
      prompt_tokens: options.prompt_tokens ?? 100,
      completion_tokens: options.completion_tokens ?? 50,
    },
    model: options.model ?? "mock-model",
    cache_hit: false,
    raw: null,
  };
}

describe("core/extractor", () => {
  let projectId: string | null = null;
  let bytes: ArrayBuffer;

  beforeEach(async () => {
    bytes = await makeTestEpub();
    const project = await createProject({
      name: "Extractor",
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
  });

  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  describe("extractEntities", () => {
    it("parses entities, persists an llm_call, and proposes glossary entries", async () => {
      const provider = new MockProvider();
      vi.spyOn(provider, "chat").mockImplementation(async (_req: ChatRequest) =>
        chatResult(
          extractorPayload({
            entities: [
              {
                type: "character",
                source: "Aldric",
                target: "Aldric",
                evidence: "Aldric stood before the gates",
                confidence: 0.9,
              },
              {
                type: "place",
                source: "Eldoria",
                target: "Eldória",
                evidence: "the gates of Eldoria",
                confidence: 0.95,
              },
            ],
            pov: "third_limited",
            tense: "past",
            register: "genre",
            audience: "young_adult",
          }),
        ),
      );

      const out = await extractEntities({
        project_id: projectId!,
        source_lang: "en",
        target_lang: "pt",
        source_text: "Aldric stood before the gates of Eldoria.",
        provider,
        options: { model: "mock-model" },
      });

      expect(out.cache_hit).toBe(false);
      expect(out.trace.entities).toHaveLength(2);
      expect(out.trace.pov).toBe("third_limited");
      expect(out.proposed_entry_ids).toHaveLength(2);

      const entries = await listGlossaryEntries(projectId!);
      const sources = entries
        .map((e) => e.entry.source_term)
        .filter((s): s is string => Boolean(s))
        .sort();
      expect(sources).toEqual(["Aldric", "Eldoria"]);
      for (const e of entries) {
        expect(e.entry.status).toBe("proposed");
      }

      const db = openProjectDb(projectId!);
      const calls = await db.llm_calls.toArray();
      expect(calls).toHaveLength(1);
      expect(calls[0].purpose).toBe(PURPOSE_EXTRACT);
      expect(calls[0].cache_hit).toBe(0);

      const events = await db.events.toArray();
      const extracted = events.filter((e) => e.kind === "entity.extracted");
      expect(extracted).toHaveLength(1);
    });

    it("replays from cache without hitting the provider", async () => {
      const provider = new MockProvider();
      // Empty entities + explicit empty glossary on both sides keeps the
      // glossary-state-hash stable between calls, so the cache key is
      // identical and the second call hits.
      const spy = vi
        .spyOn(provider, "chat")
        .mockImplementation(async (_req: ChatRequest) =>
          chatResult(extractorPayload({ entities: [] })),
        );

      const first = await extractEntities({
        project_id: projectId!,
        source_lang: "en",
        target_lang: "pt",
        source_text: "Eldoria stood tall.",
        provider,
        options: { model: "mock-model" },
        glossary: [],
      });
      expect(first.cache_hit).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);

      const second = await extractEntities({
        project_id: projectId!,
        source_lang: "en",
        target_lang: "pt",
        source_text: "Eldoria stood tall.",
        provider,
        options: { model: "mock-model" },
        glossary: [],
      });
      expect(second.cache_hit).toBe(true);
      expect(second.cost_usd).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("records a failed extract row and rethrows on malformed JSON", async () => {
      const provider = new MockProvider();
      vi.spyOn(provider, "chat").mockImplementation(async (_req: ChatRequest) =>
        chatResult("not valid json at all"),
      );

      await expect(
        extractEntities({
          project_id: projectId!,
          source_lang: "en",
          target_lang: "pt",
          source_text: "Lyra waited beneath the Long Night.",
          provider,
          options: { model: "mock-model", response_format: null },
        }),
      ).rejects.toThrow();

      const db = openProjectDb(projectId!);
      const calls = await db.llm_calls.toArray();
      expect(calls).toHaveLength(1);
      expect(calls[0].purpose).toBe(PURPOSE_EXTRACT);

      const events = await db.events.toArray();
      const failed = events.filter((e) => e.kind === "entity.extract_failed");
      expect(failed.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("runBookIntake", () => {
    it("walks the first chunk, accumulates a summary, and persists an intake_run", async () => {
      const provider = new MockProvider();
      vi.spyOn(provider, "chat").mockImplementation(async (_req: ChatRequest) =>
        chatResult(
          extractorPayload({
            entities: [
              {
                type: "character",
                source: "Aldric",
                target: "Aldric",
                evidence: "Aldric stood",
              },
            ],
            register: "genre",
            audience: "young_adult",
            pov: "third_limited",
            tense: "past",
          }),
        ),
      );

      const summary = await runBookIntake({
        project_id: projectId!,
        source_lang: "en",
        target_lang: "pt",
        provider,
        options: { model: "mock-model", chunk_max_tokens: 4000 },
      });

      expect(summary.chunks).toBeGreaterThanOrEqual(1);
      expect(summary.proposed_count).toBeGreaterThanOrEqual(1);
      expect(summary.failed_chunks).toBe(0);
      expect(summary.pov).toBe("third_limited");
      expect(summary.tense).toBe("past");
      expect(summary.register).toBe("genre");
      expect(summary.audience).toBe("young_adult");
      // young_adult audience overrides register in the P5 mapper.
      expect(summary.suggested_style_profile).toBe("young_adult");

      const runs = await listIntakeRuns(projectId!);
      expect(runs).toHaveLength(1);
      expect(runs[0].kind).toBe("book_intake");
      expect(runs[0].status).toBe("completed");

      const linked = await listIntakeRunEntries(projectId!, runs[0].id);
      expect(linked.length).toBeGreaterThanOrEqual(1);

      const db = openProjectDb(projectId!);
      const events = await db.events.toArray();
      expect(events.some((e) => e.kind === "intake.started")).toBe(true);
      expect(events.some((e) => e.kind === "intake.completed")).toBe(true);
    });

    it("aborts after the failure-streak limit trips and records the run", async () => {
      const provider = new MockProvider();
      vi.spyOn(provider, "chat").mockImplementation(async (_req: ChatRequest) =>
        chatResult("totally not json"),
      );

      const summary = await runBookIntake({
        project_id: projectId!,
        source_lang: "en",
        target_lang: "pt",
        provider,
        options: {
          model: "mock-model",
          chunk_max_tokens: 4,
          failure_streak_limit: 2,
        },
      });

      expect(summary.failed_chunks).toBeGreaterThanOrEqual(2);
      expect(summary.proposed_count).toBe(0);

      const runs = await listIntakeRuns(projectId!);
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("aborted");

      const db = openProjectDb(projectId!);
      const events = await db.events.toArray();
      expect(events.some((e) => e.kind === "intake.aborted")).toBe(true);
    });
  });

  describe("runPrePass", () => {
    async function readChapterSegmentRows(
      project_id: string,
      chapter_id: string,
    ): Promise<SegmentRow[]> {
      const db = openProjectDb(project_id);
      return db.segments
        .where("[chapter_id+idx]")
        .between([chapter_id, 0], [chapter_id, Infinity])
        .toArray();
    }

    it("walks supplied segments and writes a chapter_pre_pass run", async () => {
      const chapters = await listChapters(projectId!);
      const ch1Segs = await readChapterSegmentRows(projectId!, chapters[0].id);

      const provider = new MockProvider();
      vi.spyOn(provider, "chat").mockImplementation(async (_req: ChatRequest) =>
        chatResult(
          extractorPayload({
            entities: [
              {
                type: "organization",
                source: "Council of Five",
                target: "Conselho dos Cinco",
                evidence: "The Council of Five had warned him",
              },
            ],
          }),
        ),
      );

      const summary = await runPrePass({
        project_id: projectId!,
        source_lang: "en",
        target_lang: "pt",
        provider,
        options: { model: "mock-model", chunk_max_tokens: 4000 },
        segments: ch1Segs,
      });

      expect(summary.chunks).toBeGreaterThanOrEqual(1);
      expect(summary.proposed_count).toBeGreaterThanOrEqual(1);

      const runs = await listIntakeRuns(projectId!);
      expect(runs).toHaveLength(1);
      expect(runs[0].kind).toBe("chapter_pre_pass");
      expect(runs[0].chapter_id).toBe(chapters[0].id);
      expect(runs[0].status).toBe("completed");

      const db = openProjectDb(projectId!);
      const events = await db.events.toArray();
      expect(events.some((e) => e.kind === "batch.pre_pass_started")).toBe(true);
      expect(events.some((e) => e.kind === "batch.pre_pass_completed")).toBe(true);
    });

    it("emits per-chunk callbacks for each step", async () => {
      const chapters = await listChapters(projectId!);
      const ch1Segs = await readChapterSegmentRows(projectId!, chapters[0].id);

      const provider = new MockProvider();
      vi.spyOn(provider, "chat").mockImplementation(async (_req: ChatRequest) =>
        chatResult(extractorPayload({ entities: [] })),
      );

      const calls: Array<{ chunk_index: number; success: boolean }> = [];
      await runPrePass({
        project_id: projectId!,
        source_lang: "en",
        target_lang: "pt",
        provider,
        options: { model: "mock-model", chunk_max_tokens: 4000 },
        segments: ch1Segs,
        on_chunk: (ev) =>
          calls.push({ chunk_index: ev.chunk_index, success: ev.success }),
      });
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0]?.success).toBe(true);
    });

    it("returns an empty summary when given no segments", async () => {
      const provider = new MockProvider();
      const spy = vi.spyOn(provider, "chat");

      const summary = await runPrePass({
        project_id: projectId!,
        source_lang: "en",
        target_lang: "pt",
        provider,
        options: { model: "mock-model" },
        segments: [],
      });

      expect(summary.chunks).toBe(0);
      expect(summary.proposed_count).toBe(0);
      expect(spy).not.toHaveBeenCalled();

      const runs = await listIntakeRuns(projectId!);
      expect(runs).toHaveLength(1);
      expect(runs[0].kind).toBe("chapter_pre_pass");
      expect(runs[0].status).toBe("completed");
    });
  });
});
