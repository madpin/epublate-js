/**
 * Tests for `core/summary` — the helper-LLM passes that draft a
 * book-level premise and per-chapter recaps.
 */

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PURPOSE_SUMMARIZE,
  runBookSummary,
  runChapterSummary,
} from "@/core/summary";
import { runProjectIntake } from "@/core/project_intake";
import { openProjectDb } from "@/db/dexie";
import { listChapters } from "@/db/repo/chapters";
import { listIntakeRuns } from "@/db/repo/intake";
import {
  createProject,
  deleteProject,
  loadProject,
} from "@/db/repo/projects";
import { type ChatRequest, type ChatResult } from "@/llm/base";
import { MockProvider } from "@/llm/mock";
import { IntakeRunKind, IntakeRunStatus } from "@/db/schema";

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
    <dc:title>Summary Test</dc:title>
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
    <h1>The Departure</h1>
    <p>The little prince left his asteroid one cold morning.</p>
    <p>He brought nothing but a curious bird and a sad rose.</p>
  </body>
</html>`;

const CH2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Two</title></head>
  <body>
    <h2>The Fox</h2>
    <p>On the third planet he met a clever fox who taught him about friendship.</p>
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

function chatResult(
  content: string,
  options: { model?: string; prompt_tokens?: number; completion_tokens?: number } = {},
): ChatResult {
  return {
    content,
    usage: {
      prompt_tokens: options.prompt_tokens ?? 80,
      completion_tokens: options.completion_tokens ?? 40,
    },
    model: options.model ?? "mock-model",
    cache_hit: false,
    raw: null,
  };
}

describe("core/summary", () => {
  let projectId: string | null = null;

  beforeEach(async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Summary",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "s.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "s.epub",
    });
  });

  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  describe("runBookSummary", () => {
    it("writes the helper response into projects.book_summary and audits llm_call + intake_run", async () => {
      const provider = new MockProvider();
      const spy = vi
        .spyOn(provider, "chat")
        .mockImplementation(async (_req: ChatRequest) =>
          chatResult(
            JSON.stringify({
              summary:
                "A small prince leaves his rose to wander between worlds, meeting a fox who teaches him to look with the heart.",
              register: "literary",
              audience: "general",
              notes: null,
            }),
          ),
        );

      const result = await runBookSummary({
        project_id: projectId!,
        source_lang: "en",
        target_lang: "pt",
        provider,
        options: { model: "mock-model" },
      });

      expect(spy).toHaveBeenCalled();
      expect(result.summary).toContain("small prince");
      expect(result.trace?.register).toBe("literary");
      expect(result.error).toBeNull();

      const project = await loadProject(projectId!);
      expect(project.book_summary).toContain("small prince");

      const db = openProjectDb(projectId!);
      const calls = await db.llm_calls
        .where("purpose")
        .equals(PURPOSE_SUMMARIZE)
        .toArray();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]!.model).toBe("mock-model");
      // `cache_hit` is persisted as 0/1 in IndexedDB so we coerce.
      expect(Boolean(calls[0]!.cache_hit)).toBe(false);

      const runs = await listIntakeRuns(projectId!, {
        kind: IntakeRunKind.BOOK_SUMMARY,
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe(IntakeRunStatus.COMPLETED);
      expect(runs[0]!.cost_usd).toBeGreaterThanOrEqual(0);
    });

    it("a second run with the same prompt is a cache hit (no second network call)", async () => {
      const provider = new MockProvider();
      const spy = vi
        .spyOn(provider, "chat")
        .mockImplementation(async (_req: ChatRequest) =>
          chatResult(
            JSON.stringify({
              summary: "A wandering prince meets a fox.",
              register: null,
              audience: null,
              notes: null,
            }),
          ),
        );

      await runBookSummary({
        project_id: projectId!,
        source_lang: "en",
        target_lang: "pt",
        provider,
        options: { model: "mock-model" },
      });
      const first_calls = spy.mock.calls.length;

      const second = await runBookSummary({
        project_id: projectId!,
        source_lang: "en",
        target_lang: "pt",
        provider,
        options: { model: "mock-model" },
      });
      expect(spy.mock.calls.length).toBe(first_calls);
      expect(second.cached_chunks).toBeGreaterThan(0);
      expect(second.summary).toContain("wandering prince");
    });

    it("a malformed JSON response is recorded as a failed call and surfaces an error", async () => {
      const provider = new MockProvider();
      vi.spyOn(provider, "chat").mockImplementation(async (_req: ChatRequest) =>
        chatResult("definitely not json"),
      );

      const result = await runBookSummary({
        project_id: projectId!,
        source_lang: "en",
        target_lang: "pt",
        provider,
        options: { model: "mock-model" },
      });
      expect(result.summary).toBeNull();
      expect(result.failed_chunks).toBeGreaterThan(0);
      expect(result.error).toBeTruthy();

      const project = await loadProject(projectId!);
      expect(project.book_summary ?? null).toBeNull();

      const db = openProjectDb(projectId!);
      const events = await db.events.where("project_id").equals(projectId!).toArray();
      const failed = events.filter((e) => e.kind === "summary.failed");
      expect(failed.length).toBeGreaterThan(0);
    });
  });

  describe("runChapterSummary", () => {
    it("writes the response into chapter.notes and audits an intake_run for the chapter", async () => {
      const provider = new MockProvider();
      vi.spyOn(provider, "chat").mockImplementation(async (_req: ChatRequest) =>
        chatResult(
          JSON.stringify({
            summary:
              "The little prince leaves his asteroid carrying only a bird and a rose.",
            pov_shift: null,
            scene_label: "departure",
          }),
        ),
      );

      const chapters = await listChapters(projectId!);
      const target = chapters[0]!;

      const results = await runChapterSummary({
        project_id: projectId!,
        source_lang: "en",
        target_lang: "pt",
        provider,
        options: { model: "mock-model" },
        chapter_id: target.id,
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.summary).toContain("little prince");
      expect(results[0]!.trace?.scene_label).toBe("departure");
      expect(results[0]!.error).toBeNull();

      const refreshed = await listChapters(projectId!);
      const updated = refreshed.find((c) => c.id === target.id)!;
      expect(updated.notes).toContain("little prince");

      const runs = await listIntakeRuns(projectId!, {
        kind: IntakeRunKind.CHAPTER_SUMMARY,
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]!.chapter_id).toBe(target.id);
      expect(runs[0]!.status).toBe(IntakeRunStatus.COMPLETED);
    });

    it("only_missing skips chapters that already have notes", async () => {
      const provider = new MockProvider();
      const spy = vi
        .spyOn(provider, "chat")
        .mockImplementation(async (_req: ChatRequest) =>
          chatResult(
            JSON.stringify({
              summary: "Recap.",
              pov_shift: null,
              scene_label: null,
            }),
          ),
        );

      const chapters = await listChapters(projectId!);
      const first = chapters[0]!;
      // Pre-fill the first chapter's notes so only_missing skips it.
      const db = openProjectDb(projectId!);
      await db.chapters.update(first.id, { notes: "pre-existing notes" });

      await runChapterSummary({
        project_id: projectId!,
        source_lang: "en",
        target_lang: "pt",
        provider,
        options: { model: "mock-model" },
        only_missing: true,
      });
      // We had two chapters; only the second should have been called.
      expect(spy.mock.calls.length).toBe(1);

      const refreshed = await listChapters(projectId!);
      const first_after = refreshed.find((c) => c.id === first.id)!;
      expect(first_after.notes).toBe("pre-existing notes");
    });

    it("refuses to summarise a chapter id that does not belong to the project", async () => {
      const provider = new MockProvider();
      vi.spyOn(provider, "chat").mockImplementation(async (_req: ChatRequest) =>
        chatResult(JSON.stringify({ summary: "x" })),
      );

      await expect(
        runChapterSummary({
          project_id: projectId!,
          source_lang: "en",
          target_lang: "pt",
          provider,
          options: { model: "mock-model" },
          chapter_id: "no-such-chapter",
        }),
      ).rejects.toThrow(/chapter not found/);
    });
  });
});
