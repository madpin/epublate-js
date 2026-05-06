import { afterEach, describe, it, expect } from "vitest";

import {
  applyStyleProfile,
  createProject,
  deleteProject,
  getOriginalEpubBytes,
  loadProject,
  updateProjectSettings,
} from "./projects";
import { findLatestStyleSuggestion, recordIntakeRun } from "./intake";
import { openProjectDb } from "../dexie";
import { libraryDb } from "../library";
import {
  DEFAULT_PROMPT_OPTIONS,
  IntakeRunKind,
  IntakeRunStatus,
  type PromptOptions,
} from "../schema";
import { resolvePromptOptions } from "@/core/prompt_options";

describe("createProject", () => {
  it("writes both the per-project and library rows + stores the source blob", async () => {
    const file_bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

    const project = await createProject({
      name: "Test Project",
      source_lang: "ja",
      target_lang: "pt",
      source_filename: "sample.epub",
      source_bytes: file_bytes.buffer,
    });

    expect(project.id).toMatch(/^[0-9a-z]{16}$/);
    expect(project.name).toBe("Test Project");

    const reread = await loadProject(project.id);
    expect(reread.name).toBe("Test Project");

    const lib_row = await libraryDb().projects.get(project.id);
    expect(lib_row?.source_filename).toBe("sample.epub");
    expect(lib_row?.source_size_bytes).toBe(file_bytes.byteLength);

    const stored_buf = await getOriginalEpubBytes(project.id);
    expect(stored_buf).toBeDefined();
    const stored_bytes = new Uint8Array(stored_buf!);
    expect(stored_bytes).toEqual(file_bytes);

    await deleteProject(project.id);
    const after = await libraryDb().projects.get(project.id);
    expect(after).toBeUndefined();
  });
});

describe("applyStyleProfile + findLatestStyleSuggestion", () => {
  let project_id: string | null = null;
  afterEach(async () => {
    if (project_id) {
      await deleteProject(project_id);
      project_id = null;
    }
  });

  it("writes a style.applied event and patches both fields", async () => {
    const project = await createProject({
      name: "Style Test",
      source_lang: "ja",
      target_lang: "en",
      source_filename: "sample.epub",
      source_bytes: new Uint8Array([1]).buffer,
    });
    project_id = project.id;

    await applyStyleProfile(project.id, {
      style_profile: "young_adult",
      style_guide: "Translate as YA fantasy.",
      source: "intake:run-123",
    });

    const reread = await loadProject(project.id);
    expect(reread.style_profile).toBe("young_adult");
    expect(reread.style_guide).toBe("Translate as YA fantasy.");

    const db = openProjectDb(project.id);
    const events = await db.events
      .where("project_id")
      .equals(project.id)
      .toArray();
    const applied = events.find((e) => e.kind === "style.applied");
    expect(applied).toBeDefined();
    const payload = JSON.parse(applied!.payload_json) as Record<
      string,
      unknown
    >;
    expect(payload.profile).toBe("young_adult");
    expect(payload.source).toBe("intake:run-123");
  });

  it("findLatestStyleSuggestion returns the newest run with a non-null suggestion", async () => {
    const project = await createProject({
      name: "Sniff Test",
      source_lang: "ja",
      target_lang: "en",
      source_filename: "sample.epub",
      source_bytes: new Uint8Array([1]).buffer,
    });
    project_id = project.id;

    await recordIntakeRun({
      project_id: project.id,
      kind: IntakeRunKind.BOOK_INTAKE,
      helper_model: "stub",
      started_at: 100,
      finished_at: 110,
      status: IntakeRunStatus.COMPLETED,
      chunks: 1,
      cached_chunks: 0,
      proposed_count: 0,
      failed_chunks: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      suggested_style_profile: null,
    });
    await recordIntakeRun({
      project_id: project.id,
      kind: IntakeRunKind.BOOK_INTAKE,
      helper_model: "stub",
      started_at: 200,
      finished_at: 210,
      status: IntakeRunStatus.COMPLETED,
      chunks: 1,
      cached_chunks: 0,
      proposed_count: 0,
      failed_chunks: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      suggested_style_profile: "literary_fiction",
    });
    await recordIntakeRun({
      project_id: project.id,
      kind: IntakeRunKind.TONE_SNIFF,
      helper_model: "stub",
      started_at: 300,
      finished_at: 310,
      status: IntakeRunStatus.COMPLETED,
      chunks: 1,
      cached_chunks: 0,
      proposed_count: 0,
      failed_chunks: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      suggested_style_profile: "young_adult",
    });

    const latest = await findLatestStyleSuggestion(project.id);
    expect(latest).not.toBeNull();
    expect(latest!.suggested_style_profile).toBe("young_adult");
    expect(latest!.kind).toBe(IntakeRunKind.TONE_SNIFF);
  });

  it("returns null when no run has a suggestion", async () => {
    const project = await createProject({
      name: "Empty",
      source_lang: "ja",
      target_lang: "en",
      source_filename: "sample.epub",
      source_bytes: new Uint8Array([1]).buffer,
    });
    project_id = project.id;
    const latest = await findLatestStyleSuggestion(project.id);
    expect(latest).toBeNull();
  });
});

describe("ProjectRow prompt-config fields", () => {
  let project_id: string | null = null;
  afterEach(async () => {
    if (project_id) {
      await deleteProject(project_id);
      project_id = null;
    }
  });

  it("legacy rows omit book_summary + prompt_options and resolve to defaults", async () => {
    const project = await createProject({
      name: "Legacy",
      source_lang: "ja",
      target_lang: "en",
      source_filename: "sample.epub",
      source_bytes: new Uint8Array([1]).buffer,
    });
    project_id = project.id;

    const reread = await loadProject(project.id);
    expect(reread.book_summary).toBeUndefined();
    expect(reread.prompt_options).toBeUndefined();

    expect(resolvePromptOptions(reread.prompt_options)).toEqual(
      DEFAULT_PROMPT_OPTIONS,
    );
  });

  it("round-trips book_summary and prompt_options through Dexie", async () => {
    const project = await createProject({
      name: "Settings",
      source_lang: "ja",
      target_lang: "en",
      source_filename: "sample.epub",
      source_bytes: new Uint8Array([1]).buffer,
    });
    project_id = project.id;

    const opts: PromptOptions = {
      ...DEFAULT_PROMPT_OPTIONS,
      include_proposed_hints: false,
      include_recent_context: false,
    };
    await updateProjectSettings(project.id, {
      book_summary: "  A coming-of-age novella set in postwar Tokyo. ",
      prompt_options: opts,
    });

    const reread = await loadProject(project.id);
    expect(reread.book_summary).toBe(
      "A coming-of-age novella set in postwar Tokyo.",
    );
    expect(reread.prompt_options).toEqual(opts);

    await updateProjectSettings(project.id, {
      book_summary: "   ",
      prompt_options: null,
    });

    const cleared = await loadProject(project.id);
    expect(cleared.book_summary).toBeNull();
    expect(cleared.prompt_options).toBeNull();
    expect(resolvePromptOptions(cleared.prompt_options)).toEqual(
      DEFAULT_PROMPT_OPTIONS,
    );

    const db = openProjectDb(project.id);
    const event_kinds = (
      await db.events.where("project_id").equals(project.id).toArray()
    ).map((e) => e.kind);
    expect(event_kinds).toContain("project.updated");
  });
});
