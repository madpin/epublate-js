/**
 * Mirror of `epublate.db.schema` (Python).
 *
 * Each Python `Table` is a TS interface here; each Python "status enum"
 * class is a TS const + literal-union type so the rest of the codebase
 * can `import { SegmentStatus } from "@/db/schema"` and treat it the
 * same as the original `from epublate.db.schema import SegmentStatus`.
 *
 * Numeric timestamps are stored as Unix epoch **milliseconds** (the
 * Python codebase uses seconds for cross-tool portability with SQLite
 * INTEGER columns; in JS we live in ms because `Date.now()` returns
 * ms and IndexedDB cursors compare ms naturally). The export bundle
 * carries milliseconds verbatim; an importer for the Python tool can
 * `Math.round(ms / 1000)` if it ever lands.
 */

// ---------- Status enums ----------

export const ChapterStatus = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  DONE: "done",
  LOCKED: "locked",
} as const;
export type ChapterStatusT =
  (typeof ChapterStatus)[keyof typeof ChapterStatus];

export const SegmentStatus = {
  PENDING: "pending",
  TRANSLATED: "translated",
  VALIDATED: "validated",
  FLAGGED: "flagged",
  APPROVED: "approved",
} as const;
export type SegmentStatusT =
  (typeof SegmentStatus)[keyof typeof SegmentStatus];

export const GlossaryStatus = {
  PROPOSED: "proposed",
  CONFIRMED: "confirmed",
  LOCKED: "locked",
} as const;
export type GlossaryStatusT =
  (typeof GlossaryStatus)[keyof typeof GlossaryStatus];

export const ProjectKind = {
  BOOK: "book",
  LORE: "lore",
} as const;
export type ProjectKindT = (typeof ProjectKind)[keyof typeof ProjectKind];

export const AttachedLoreMode = {
  READ_ONLY: "read_only",
  WRITABLE: "writable",
} as const;
export type AttachedLoreModeT =
  (typeof AttachedLoreMode)[keyof typeof AttachedLoreMode];

export const LoreSourceKind = {
  SOURCE: "source",
  TARGET: "target",
} as const;
export type LoreSourceKindT =
  (typeof LoreSourceKind)[keyof typeof LoreSourceKind];

export const LoreSourceStatus = {
  INGESTED: "ingested",
  FAILED: "failed",
} as const;
export type LoreSourceStatusT =
  (typeof LoreSourceStatus)[keyof typeof LoreSourceStatus];

export const IntakeRunKind = {
  BOOK_INTAKE: "book_intake",
  CHAPTER_PRE_PASS: "chapter_pre_pass",
  TONE_SNIFF: "tone_sniff",
} as const;
export type IntakeRunKindT =
  (typeof IntakeRunKind)[keyof typeof IntakeRunKind];

export const IntakeRunStatus = {
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  ABORTED: "aborted",
  RATE_LIMITED: "rate_limited",
  FAILED: "failed",
} as const;
export type IntakeRunStatusT =
  (typeof IntakeRunStatus)[keyof typeof IntakeRunStatus];

export type EntityType =
  | "character"
  | "place"
  | "organization"
  | "event"
  | "item"
  | "date_or_time"
  | "phrase"
  | "term"
  | "other";

export type GenderTag =
  | "feminine"
  | "masculine"
  | "neuter"
  | "common"
  | "unspecified";

export type AliasSide = "source" | "target";

// ---------- Per-project DB rows ----------

/** Row in `projects` (lives in the per-project DB; one row per DB). */
export interface ProjectRow {
  id: string;
  name: string;
  source_lang: string;
  target_lang: string;
  /** Logical "source path" — kept for parity; in browser this is a synthetic name. */
  source_path: string;
  style_guide: string | null;
  style_profile: string | null;
  budget_usd: number | null;
  /** JSON-serialized override blob. See `epublate.db.repo.set_llm_overrides`. */
  llm_overrides: string | null;
  created_at: number;
  kind: ProjectKindT;
  context_max_segments: number;
  context_max_chars: number;
  /**
   * Context-window selection strategy:
   *   - `"off"`     — no context block, even for `context_max_segments > 0`.
   *   - `"previous"` (default) — feed the previous N segments verbatim
   *     (legacy behaviour).
   *   - `"dialogue"` — only build a context block when the segment
   *     looks like spoken dialogue, and only fill it with previously
   *     translated dialogue lines from the same chapter. Non-dialogue
   *     prose (description, narration) goes through with no context
   *     overhead, which is much cheaper for novels that mix narration
   *     and exchanges.
   *
   * Pre-existing rows missing this field default to `"previous"`.
   */
  context_mode?: "off" | "previous" | "dialogue";
}

export interface ChapterRow {
  id: string;
  project_id: string;
  spine_idx: number;
  href: string;
  title: string | null;
  status: ChapterStatusT;
  /**
   * Optional curator-authored summary / notes for this chapter. Surfaces
   * in the Reader and is injected into the translator prompt as a
   * "Chapter context" block — useful for capturing POV switches,
   * recurring imagery, or scene-level disambiguations that the model
   * can't infer from the segment alone.
   *
   * Pre-existing rows missing this field implicitly default to `null`.
   */
  notes?: string | null;
}

export interface SegmentRow {
  id: string;
  chapter_id: string;
  idx: number;
  source_text: string;
  source_hash: string;
  target_text: string | null;
  status: SegmentStatusT;
  /**
   * Serialized inline-skeleton JSON. Stored as a string (rather than
   * Uint8Array as in the Python BLOB column) so JSONL export is a
   * trivial round-trip without base64 plumbing.
   */
  inline_skeleton: string | null;
}

export interface GlossaryEntryRow {
  id: string;
  project_id: string;
  type: EntityType;
  /** NULL for target-only entries (PRD F-LB-9). */
  source_term: string | null;
  target_term: string;
  gender: GenderTag | null;
  status: GlossaryStatusT;
  notes: string | null;
  first_seen_segment_id: string | null;
  created_at: number;
  updated_at: number;
  /** False ⇒ target-only; locked rows are then *soft*-locked in the validator. */
  source_known: boolean;
}

export interface GlossaryAliasRow {
  id: string;
  entry_id: string;
  side: AliasSide;
  text: string;
}

export interface GlossaryRevisionRow {
  id: string;
  entry_id: string;
  prev_target_term: string | null;
  new_target_term: string | null;
  reason: string | null;
  created_at: number;
}

export interface EntityMentionRow {
  id: string;
  segment_id: string;
  entry_id: string;
  source_span_start: number | null;
  source_span_end: number | null;
}

export interface LlmCallRow {
  id: string;
  project_id: string;
  segment_id: string | null;
  /** translate | translate_group | extract | extract_target | review | tone_sniff … */
  purpose: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  cache_hit: 0 | 1;
  cache_key: string | null;
  request_json: string | null;
  response_json: string | null;
  created_at: number;
}

export interface EmbeddingRow {
  id: string;
  scope: "segment" | "glossary_entry";
  ref_id: string;
  model: string;
  dim: number;
  vector: Uint8Array;
}

export interface EventRow {
  id?: number;
  project_id: string;
  ts: number;
  kind: string;
  payload_json: string;
}

export interface LoreMetaRow {
  project_id: string;
  description: string | null;
  schema_version: number;
  default_proposal_kind: LoreSourceKindT;
  created_at: number;
  updated_at: number;
}

export interface LoreSourceRow {
  id: string;
  project_id: string;
  kind: LoreSourceKindT;
  epub_path: string;
  status: LoreSourceStatusT;
  entries_added: number;
  notes: string | null;
  ingested_at: number;
}

export interface AttachedLoreRow {
  id: string;
  project_id: string;
  /** Logical Lore-Book identifier (the per-Lore-Book DB id). */
  lore_path: string;
  mode: AttachedLoreModeT;
  priority: number;
  attached_at: number;
}

export interface IntakeRunRow {
  id: string;
  project_id: string;
  kind: IntakeRunKindT;
  chapter_id: string | null;
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
  pov: string | null;
  tense: string | null;
  register: string | null;
  audience: string | null;
  suggested_style_profile: string | null;
  notes: string | null;
  curator_notes: string | null;
  error: string | null;
}

export interface IntakeRunEntryRow {
  intake_run_id: string;
  entry_id: string;
  created_at: number;
}

// ---------- Library DB rows (top-level "recents" / "libraries") ----------

/**
 * One row in the top-level library DB. Mirrors a row of the Python
 * `~/.config/epublate/recents.json` file plus the persistent
 * "currently-known projects" table.
 */
export interface LibraryProjectRow {
  /** Same id as the per-project DB's `projects[0].id`. */
  id: string;
  name: string;
  source_lang: string;
  target_lang: string;
  source_filename: string;
  /** Bytes of the original.epub blob, for quick UI hints. */
  source_size_bytes: number;
  /** When the project was last opened. Drives the "recents" sort. */
  opened_at: number;
  created_at: number;
  /** Cached small-cap progress hint so we don't have to open every DB on Projects render. */
  progress_translated: number;
  progress_total: number;
  /** Optional per-project active style profile slug. */
  style_profile: string | null;
  /**
   * Optional cover image extracted from the source ePub at intake.
   * Stored as raw bytes so the Projects list can render thumbnails
   * without opening every per-project DB. Older rows (created before
   * cover extraction shipped) are missing both fields, which the UI
   * treats as "no cover".
   */
  cover_image_bytes?: ArrayBuffer | null;
  cover_image_media_type?: string | null;
}

export interface LibraryLoreBookRow {
  id: string;
  name: string;
  source_lang: string;
  target_lang: string;
  description: string | null;
  default_proposal_kind: LoreSourceKindT;
  created_at: number;
  opened_at: number;
  /** Cached entry counts. */
  entries_total: number;
  entries_locked: number;
}

export interface LibraryUiPrefsRow {
  /** Singleton row, key = `"prefs"`. */
  key: "prefs";
  theme: ThemeIdT;
  auto_tone_sniff: boolean;
  /** Last-used ePub source pref (path / filename). */
  last_source_filename: string | null;
  /**
   * Default budget cap (USD) prefilled into the BatchModal. The
   * project still owns its own runtime budget; this is just a UX
   * convenience so curators can set "I never want to spend more than
   * $X per batch" once.
   */
  default_budget_usd?: number | null;
  /** Default batch concurrency (translator slots). */
  default_concurrency?: number;
  /**
   * Most recently used source / target language slugs in the New
   * Project flow. Both default to a sensible pair the first time the
   * curator launches the app, then track whatever they typed last so
   * the next book in the same series fills in automatically.
   */
  last_source_lang?: string | null;
  last_target_lang?: string | null;
}

export interface LibraryLlmConfigRow {
  /** Singleton row, key = `"llm"`. */
  key: "llm";
  base_url: string;
  api_key: string;
  model: string;
  helper_model: string | null;
  organization: string | null;
  reasoning_effort: "minimal" | "low" | "medium" | "high" | null;
  /**
   * Curator-defined pricing overrides keyed by model slug, in USD per
   * million tokens. Layered on top of the package defaults at boot
   * via :func:`applyPricingOverrides`. Rows older than this column
   * carry no overrides, so the field is optional.
   */
  pricing_overrides?: Record<
    string,
    { input_per_mtok: number; output_per_mtok: number }
  >;
}

// ---------- UI tokens ----------

export const ThemeId = {
  EPUBLATE: "epublate",
  TEXTUAL_DARK: "textual-dark",
  TEXTUAL_LIGHT: "textual-light",
  EPUBLATE_CONTRAST: "epublate-contrast",
} as const;
export type ThemeIdT = (typeof ThemeId)[keyof typeof ThemeId];

export const THEME_ORDER: readonly ThemeIdT[] = [
  ThemeId.EPUBLATE,
  ThemeId.TEXTUAL_DARK,
  ThemeId.TEXTUAL_LIGHT,
  ThemeId.EPUBLATE_CONTRAST,
];

export const THEME_LABELS: Record<ThemeIdT, string> = {
  [ThemeId.EPUBLATE]: "epublate",
  [ThemeId.TEXTUAL_DARK]: "textual-dark",
  [ThemeId.TEXTUAL_LIGHT]: "textual-light",
  [ThemeId.EPUBLATE_CONTRAST]: "high-contrast",
};
