/**
 * Intake-run repository (mirrors `epublate.db.repo.intake_runs`).
 *
 * `intake_runs` rows are book-intake / chapter-pre-pass audit records
 * the curator can flip through on the Intake history screen. Each
 * row carries the rolled-up token / cost / cached-chunk numbers plus
 * the helper LLM's POV / tense / register / audience guess for the
 * book intake variant.
 *
 * `intake_run_entries` is the join table linking runs to the
 * glossary entries they auto-proposed; surfaced on the Glossary
 * detail pane as "introduced by intake run X" so curators can trace
 * lineage when promoting / dismissing entries.
 */

import { openProjectDb } from "@/db/dexie";
import { newId } from "@/lib/id";
import {
  type IntakeRunEntryRow,
  type IntakeRunKindT,
  type IntakeRunRow,
  type IntakeRunStatusT,
} from "@/db/schema";

export interface RecordIntakeRunInput {
  project_id: string;
  kind: IntakeRunKindT;
  chapter_id?: string | null;
  helper_model: string;
  started_at: number;
  finished_at: number;
  status: IntakeRunStatusT;
  chunks: number;
  cached_chunks: number;
  proposed_count: number;
  failed_chunks: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  pov?: string | null;
  tense?: string | null;
  narrative_register?: string | null;
  audience?: string | null;
  suggested_style_profile?: string | null;
  notes?: readonly string[];
  error?: string | null;
}

export async function recordIntakeRun(
  input: RecordIntakeRunInput,
): Promise<IntakeRunRow> {
  const id = newId();
  const row: IntakeRunRow = {
    id,
    project_id: input.project_id,
    kind: input.kind,
    chapter_id: input.chapter_id ?? null,
    helper_model: input.helper_model,
    started_at: input.started_at,
    finished_at: input.finished_at,
    status: input.status,
    chunks: input.chunks,
    cached_chunks: input.cached_chunks,
    proposed_count: input.proposed_count,
    failed_chunks: input.failed_chunks,
    prompt_tokens: input.prompt_tokens,
    completion_tokens: input.completion_tokens,
    cost_usd: input.cost_usd,
    pov: input.pov ?? null,
    tense: input.tense ?? null,
    register: input.narrative_register ?? null,
    audience: input.audience ?? null,
    suggested_style_profile: input.suggested_style_profile ?? null,
    notes: input.notes && input.notes.length ? input.notes.join("\n\n") : null,
    curator_notes: null,
    error: input.error ?? null,
  };
  const db = openProjectDb(input.project_id);
  await db.intake_runs.put(row);
  return row;
}

export async function attachIntakeRunEntries(
  project_id: string,
  intake_run_id: string,
  entry_ids: readonly string[],
): Promise<void> {
  if (!entry_ids.length) return;
  const db = openProjectDb(project_id);
  const created_at = Date.now();
  const rows: IntakeRunEntryRow[] = entry_ids.map((entry_id) => ({
    intake_run_id,
    entry_id,
    created_at,
  }));
  await db.intake_run_entries.bulkPut(rows);
}

export async function listIntakeRuns(
  project_id: string,
  options: {
    kind?: IntakeRunKindT;
    chapter_id?: string;
    limit?: number;
  } = {},
): Promise<IntakeRunRow[]> {
  const db = openProjectDb(project_id);
  let query = db.intake_runs.where("project_id").equals(project_id);
  if (options.kind) {
    query = db.intake_runs.where("kind").equals(options.kind);
  }
  let rows = await query.toArray();
  if (options.chapter_id) {
    rows = rows.filter((r) => r.chapter_id === options.chapter_id);
  }
  // Newest first.
  rows.sort((a, b) => b.started_at - a.started_at);
  if (options.limit && options.limit > 0) {
    rows = rows.slice(0, options.limit);
  }
  return rows;
}

export async function getIntakeRun(
  project_id: string,
  intake_run_id: string,
): Promise<IntakeRunRow | undefined> {
  const db = openProjectDb(project_id);
  return db.intake_runs.get(intake_run_id);
}

export async function listIntakeRunEntries(
  project_id: string,
  intake_run_id: string,
): Promise<IntakeRunEntryRow[]> {
  const db = openProjectDb(project_id);
  return db.intake_run_entries
    .where("intake_run_id")
    .equals(intake_run_id)
    .toArray();
}

/**
 * Return the most recent intake_run that emitted a non-null
 * `suggested_style_profile`, regardless of whether the curator has
 * already applied it. Powers the Dashboard "Helper suggests …"
 * callout (PRD F-STYLE-3) and the Intake Runs row chip.
 */
export async function findLatestStyleSuggestion(
  project_id: string,
): Promise<IntakeRunRow | null> {
  const db = openProjectDb(project_id);
  const rows = await db.intake_runs
    .where("project_id")
    .equals(project_id)
    .toArray();
  const with_suggestion = rows.filter(
    (r) => typeof r.suggested_style_profile === "string" && r.suggested_style_profile,
  );
  if (!with_suggestion.length) return null;
  with_suggestion.sort((a, b) => b.started_at - a.started_at);
  return with_suggestion[0]!;
}

/**
 * Return the intake_run that introduced a given glossary entry, if
 * any. Powers the Glossary detail pane's "introduced by intake run"
 * line.
 */
export async function findIntakeRunForEntry(
  project_id: string,
  entry_id: string,
): Promise<IntakeRunRow | null> {
  const db = openProjectDb(project_id);
  const links = await db.intake_run_entries
    .where("entry_id")
    .equals(entry_id)
    .toArray();
  if (!links.length) return null;
  // Newest run wins if there are multiple (curator re-running intake).
  const ids = [...new Set(links.map((l) => l.intake_run_id))];
  const rows = await db.intake_runs.where("id").anyOf(ids).toArray();
  if (!rows.length) return null;
  rows.sort((a, b) => b.started_at - a.started_at);
  return rows[0]!;
}
