/**
 * Project lifecycle (mirrors `epublate.db.repo.create_project` /
 * `list_projects` / `delete_project`).
 *
 * The Python repo layer is a thin SQL wrapper; here, each operation
 * runs inside a Dexie transaction across the project DB and the
 * top-level library DB so the recents list always agrees with what's
 * on disk.
 */

import { newId } from "@/lib/id";
import { nowMs } from "@/lib/time";

import { openProjectDb, deleteProjectDb } from "../dexie";
import {
  removeLibraryProject,
  touchLibraryProject,
  upsertLibraryProject,
} from "../library";
import {
  type LibraryProjectRow,
  type ProjectKindT,
  type ProjectRow,
  type PromptOptions,
  ProjectKind,
} from "../schema";

export interface CreateProjectInput {
  name: string;
  source_lang: string;
  target_lang: string;
  source_filename: string;
  /** Verbatim ePub bytes. The caller (modal / importer) is responsible for the .arrayBuffer() round-trip. */
  source_bytes: ArrayBuffer;
  source_mime?: string;
  kind?: ProjectKindT;
  style_profile?: string | null;
  style_guide?: string | null;
  budget_usd?: number | null;
  context_max_segments?: number;
  context_max_chars?: number;
  context_mode?: "off" | "previous" | "dialogue" | "relevant";
  context_relevant_min_similarity?: number | null;
}

export async function createProject(
  input: CreateProjectInput,
): Promise<ProjectRow> {
  const id = newId();
  const created_at = nowMs();

  const project: ProjectRow = {
    id,
    name: input.name,
    source_lang: input.source_lang,
    target_lang: input.target_lang,
    source_path: input.source_filename,
    style_guide: input.style_guide ?? null,
    style_profile: input.style_profile ?? null,
    budget_usd: input.budget_usd ?? null,
    llm_overrides: null,
    created_at,
    kind: input.kind ?? ProjectKind.BOOK,
    context_max_segments: input.context_max_segments ?? 0,
    context_max_chars: input.context_max_chars ?? 0,
    context_mode: input.context_mode ?? "previous",
    context_relevant_min_similarity:
      input.context_relevant_min_similarity ?? null,
  };

  const bytes = input.source_bytes;
  const mime = input.source_mime ?? "application/epub+zip";
  const db = openProjectDb(id);
  await db.transaction(
    "rw",
    db.projects,
    db.events,
    db.source_blobs,
    async () => {
      await db.projects.put(project);
      await db.source_blobs.put({
        key: "original",
        filename: input.source_filename,
        mime,
        size_bytes: bytes.byteLength,
        bytes,
      });
      await db.events.add({
        project_id: id,
        ts: created_at,
        kind: "project.created",
        payload_json: JSON.stringify({
          name: input.name,
          source_lang: input.source_lang,
          target_lang: input.target_lang,
          source_filename: input.source_filename,
        }),
      });
    },
  );

  const libraryRow: LibraryProjectRow = {
    id,
    name: input.name,
    source_lang: input.source_lang,
    target_lang: input.target_lang,
    source_filename: input.source_filename,
    source_size_bytes: bytes.byteLength,
    opened_at: created_at,
    created_at,
    progress_translated: 0,
    progress_total: 0,
    style_profile: input.style_profile ?? null,
  };
  await upsertLibraryProject(libraryRow);

  return project;
}

export async function loadProject(projectId: string): Promise<ProjectRow> {
  const db = openProjectDb(projectId);
  const row = await db.projects.get(projectId);
  if (!row) throw new Error(`project not found: ${projectId}`);
  return row;
}

export async function getOriginalEpubBlob(
  projectId: string,
): Promise<Blob | undefined> {
  const db = openProjectDb(projectId);
  const row = await db.source_blobs.get("original");
  if (!row) return undefined;
  return new Blob([row.bytes], { type: row.mime });
}

export async function getOriginalEpubBytes(
  projectId: string,
): Promise<ArrayBuffer | undefined> {
  const db = openProjectDb(projectId);
  const row = await db.source_blobs.get("original");
  return row?.bytes;
}

export async function openProject(projectId: string): Promise<ProjectRow> {
  const project = await loadProject(projectId);
  await touchLibraryProject(projectId);
  return project;
}

export async function deleteProject(projectId: string): Promise<void> {
  await deleteProjectDb(projectId);
  await removeLibraryProject(projectId);
}

export async function updateProjectProgressHint(
  projectId: string,
  patch: { progress_translated: number; progress_total: number },
): Promise<void> {
  const { libraryDb } = await import("../library");
  await libraryDb().projects.update(projectId, patch);
}

export async function appendEvent(
  projectId: string,
  kind: string,
  payload: unknown,
): Promise<number> {
  const db = openProjectDb(projectId);
  return db.events.add({
    project_id: projectId,
    ts: nowMs(),
    kind,
    payload_json: JSON.stringify(payload),
  }) as Promise<number>;
}

/**
 * Patch the per-project settings stored in the project DB.
 *
 * Used by the Project Settings screen so we have one entry point that
 * also keeps the library row's display name in sync (the curator sees
 * the renamed project on the home screen). Each field is independent
 * — pass only the ones you want to change.
 *
 * `llm_overrides` is serialized to JSON; passing `null` clears the
 * override block. `name` updates both the project DB row and the
 * library projection so the recents list stays accurate.
 */
export interface UpdateProjectSettingsPatch {
  name?: string;
  style_profile?: string | null;
  style_guide?: string | null;
  budget_usd?: number | null;
  context_max_segments?: number;
  context_max_chars?: number;
  context_mode?: "off" | "previous" | "dialogue" | "relevant";
  /**
   * Minimum cosine similarity for `context_mode = "relevant"`. Pass
   * `null` to clear and fall back to the default. Phase 3.
   */
  context_relevant_min_similarity?: number | null;
  /** Pass an object to set, or `null` to clear. Will be JSON-stringified. */
  llm_overrides?: object | null;
  /**
   * Project-wide narrative summary; injected into the translator
   * prompt's `<book_summary>` block. Pass `null` (or empty after
   * trim) to clear it.
   */
  book_summary?: string | null;
  /**
   * Per-project translator-prompt toggles. Pass `null` to fall back
   * to the documented defaults; pass a `PromptOptions` to override.
   */
  prompt_options?: PromptOptions | null;
}

export async function updateProjectSettings(
  projectId: string,
  patch: UpdateProjectSettingsPatch,
): Promise<void> {
  const db = openProjectDb(projectId);
  const project_patch: Partial<ProjectRow> = {};
  if (patch.name !== undefined) project_patch.name = patch.name;
  if (patch.style_profile !== undefined) project_patch.style_profile = patch.style_profile;
  if (patch.style_guide !== undefined) project_patch.style_guide = patch.style_guide;
  if (patch.budget_usd !== undefined) project_patch.budget_usd = patch.budget_usd;
  if (patch.context_max_segments !== undefined) {
    project_patch.context_max_segments = patch.context_max_segments;
  }
  if (patch.context_max_chars !== undefined) {
    project_patch.context_max_chars = patch.context_max_chars;
  }
  if (patch.context_mode !== undefined) {
    project_patch.context_mode = patch.context_mode;
  }
  if (patch.context_relevant_min_similarity !== undefined) {
    project_patch.context_relevant_min_similarity =
      patch.context_relevant_min_similarity;
  }
  if (patch.llm_overrides !== undefined) {
    project_patch.llm_overrides = patch.llm_overrides
      ? JSON.stringify(patch.llm_overrides)
      : null;
  }
  if (patch.book_summary !== undefined) {
    const cleaned = patch.book_summary?.trim();
    project_patch.book_summary = cleaned ? cleaned : null;
  }
  if (patch.prompt_options !== undefined) {
    project_patch.prompt_options = patch.prompt_options;
  }
  if (Object.keys(project_patch).length === 0) return;
  await db.transaction("rw", db.projects, db.events, async () => {
    await db.projects.update(projectId, project_patch);
    await db.events.add({
      project_id: projectId,
      ts: nowMs(),
      kind: "project.updated",
      payload_json: JSON.stringify({
        keys: Object.keys(project_patch),
      }),
    });
  });
  if (patch.name !== undefined) {
    const { libraryDb } = await import("../library");
    await libraryDb().projects.update(projectId, { name: patch.name });
  }
}

/**
 * Apply a `(style_profile, style_guide)` pair to the project and
 * record a `style.applied` event. Mirrors `Project.update_style` from
 * the Python tool — the dashboard "Apply suggested style" button and
 * the IntakeRunsRoute "Apply style" action both go through this.
 *
 * Passing `null` for both clears the project's style guide entirely
 * (translator runs without a style block).
 */
export async function applyStyleProfile(
  projectId: string,
  patch: {
    style_profile: string | null;
    style_guide: string | null;
    /** Optional source tag for the audit event (e.g. `"intake"`). */
    source?: string;
  },
): Promise<void> {
  const db = openProjectDb(projectId);
  await db.transaction("rw", db.projects, db.events, async () => {
    await db.projects.update(projectId, {
      style_profile: patch.style_profile,
      style_guide: patch.style_guide,
    });
    await db.events.add({
      project_id: projectId,
      ts: nowMs(),
      kind: "style.applied",
      payload_json: JSON.stringify({
        profile: patch.style_profile,
        custom: patch.style_guide != null,
        source: patch.source ?? "manual",
      }),
    });
  });
}
