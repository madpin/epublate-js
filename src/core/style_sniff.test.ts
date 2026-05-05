/**
 * Tests for the pre-create tone sniff.
 *
 * Drives `sniffTone` against a tiny in-memory project — the test
 * setup pre-populates a few segments across two chapters and stubs
 * the LLM provider with a deterministic response. We assert that the
 * sniff (a) picks the right preset, (b) writes an audit row, and
 * (c) only auto-applies when the project hasn't been customized.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listProfiles } from "./style";
import { sniffTone } from "./style_sniff";
import { openProjectDb } from "@/db/dexie";
import { createProject, deleteProject } from "@/db/repo/projects";
import {
  type ChapterRow,
  ChapterStatus,
  type IntakeRunRow,
  type SegmentRow,
  SegmentStatus,
} from "@/db/schema";
import type {
  ChatRequest,
  ChatResult,
  LLMProvider,
} from "@/llm/base";

function makeProvider(content: string): LLMProvider {
  return {
    name: "stub",
    async chat(_req: ChatRequest): Promise<ChatResult> {
      return {
        content,
        usage: { prompt_tokens: 100, completion_tokens: 30 },
        model: "stub-helper",
        cache_hit: false,
        raw: {},
      };
    },
  };
}

async function seedProject(): Promise<{ project_id: string }> {
  const dummy_bytes = new TextEncoder().encode("not really an epub").buffer;
  const project = await createProject({
    name: "Test sniff",
    source_lang: "ja",
    target_lang: "en",
    source_filename: "test.epub",
    source_bytes: dummy_bytes,
  });

  const fresh = openProjectDb(project.id);
  const chapters: ChapterRow[] = [
    {
      id: "c1",
      project_id: project.id,
      spine_idx: 0,
      href: "ch1.xhtml",
      title: "Chapter 1",
      status: ChapterStatus.DONE,
    },
    {
      id: "c2",
      project_id: project.id,
      spine_idx: 1,
      href: "ch2.xhtml",
      title: "Chapter 2",
      status: ChapterStatus.DONE,
    },
  ];
  await fresh.chapters.bulkPut(chapters);

  const make_segs = (chapter_id: string, count: number): SegmentRow[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `${chapter_id}-${i}`,
      chapter_id,
      idx: i,
      source_text: `Sample sentence number ${i + 1} from ${chapter_id}.`,
      source_hash: `${chapter_id}-${i}`,
      target_text: null,
      status: SegmentStatus.PENDING,
      inline_skeleton: null,
    }));
  await fresh.segments.bulkPut([...make_segs("c1", 8), ...make_segs("c2", 8)]);

  return { project_id: project.id };
}

const HELPER_RESPONSE = JSON.stringify({
  entities: [],
  pov: "first_person",
  tense: "past",
  register: "literary",
  audience: "young adult",
});

describe("sniffTone", () => {
  let projectId: string | null = null;

  beforeEach(() => {
    projectId = null;
  });
  afterEach(async () => {
    if (projectId) {
      try {
        await deleteProject(projectId);
      } catch {
        // ignore
      }
    }
  });

  it("auto-applies the suggested profile when style is unset", async () => {
    const { project_id } = await seedProject();
    projectId = project_id;
    const provider = makeProvider(HELPER_RESPONSE);

    const summary = await sniffTone({
      project_id,
      source_lang: "ja",
      target_lang: "en",
      provider,
      helper_model: "stub-helper",
    });

    expect(summary.profile).toBe("young_adult");
    expect(summary.applied).toBe(true);
    expect(summary.sample_block_count).toBeGreaterThan(0);
    expect(summary.cost_usd).toBeGreaterThanOrEqual(0);

    // Project row updated.
    const db = openProjectDb(project_id);
    const project = await db.projects.get(project_id);
    expect(project?.style_profile).toBe("young_adult");
    const ya = listProfiles().find((p) => p.id === "young_adult");
    expect(project?.style_guide).toBe(ya?.prompt_block);

    // Audit row written.
    const runs = (await db.intake_runs.toArray()) as IntakeRunRow[];
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe("tone_sniff");
    expect(runs[0].suggested_style_profile).toBe("young_adult");
  });

  it("does not overwrite a customized style guide", async () => {
    const { project_id } = await seedProject();
    projectId = project_id;
    const db = openProjectDb(project_id);
    await db.projects.update(project_id, {
      style_profile: "literary_fiction",
      style_guide: "Custom curator-authored prose.",
    });

    const provider = makeProvider(HELPER_RESPONSE);
    const summary = await sniffTone({
      project_id,
      source_lang: "ja",
      target_lang: "en",
      provider,
      helper_model: "stub-helper",
    });

    expect(summary.profile).toBe("young_adult");
    expect(summary.applied).toBe(false);
    const project = await db.projects.get(project_id);
    expect(project?.style_guide).toBe("Custom curator-authored prose.");
    expect(project?.style_profile).toBe("literary_fiction");
  });

  it("can be told not to auto-apply", async () => {
    const { project_id } = await seedProject();
    projectId = project_id;
    const provider = makeProvider(HELPER_RESPONSE);
    const summary = await sniffTone({
      project_id,
      source_lang: "ja",
      target_lang: "en",
      provider,
      helper_model: "stub-helper",
      auto_apply: false,
    });
    expect(summary.applied).toBe(false);
    const db = openProjectDb(project_id);
    const project = await db.projects.get(project_id);
    expect(project?.style_profile).toBeNull();
    expect(project?.style_guide).toBeNull();
  });
});
