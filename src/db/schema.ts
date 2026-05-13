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
  /**
   * Background pass that embeds every segment in a project. Triggered
   * after intake (for new projects) or by curator action (for
   * existing projects when they enable embeddings). Phase 3.
   */
  EMBEDDING_PASS: "embedding_pass",
  /**
   * Curator-triggered helper-LLM pass that drafts a 150-250 word book
   * premise from the first N segments and writes it into
   * `projects.book_summary`. Source-segment-only (never the whole
   * book) so summaries don't leak endings into early-chapter prompts.
   */
  BOOK_SUMMARY: "book_summary",
  /**
   * Curator-triggered helper-LLM pass that drafts a 50-120 word
   * chapter summary and writes it into `chapters.notes`. May be
   * scoped to a single chapter or fan out across all chapters that
   * are missing notes.
   */
  CHAPTER_SUMMARY: "chapter_summary",
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
   *   - `"relevant"` — embed the segment and inject the top-K closest
   *     translated/approved segments by cosine similarity. Crosses
   *     chapter boundaries; falls back to `"previous"` when no
   *     embedding provider is configured. Phase 3.
   *
   * Pre-existing rows missing this field default to `"previous"`.
   */
  context_mode?: "off" | "previous" | "dialogue" | "relevant";
  /**
   * Minimum cosine similarity for `context_mode = "relevant"`. Anything
   * below this is dropped from the picker. Pre-existing rows fall back
   * to `0.65`, the documented default. Phase 3.
   */
  context_relevant_min_similarity?: number | null;
  /**
   * Optional curator-authored book summary / premise. Generated by the
   * helper LLM via `runBookSummary` and editable in Project Settings.
   * Injected into the translator's system prompt as a stable
   * `<book_summary>` block so the model has narrative context across
   * every segment of the book. Pre-existing rows missing this field
   * default to `null` (no block emitted).
   *
   * Generated from source-only segments (never target text), and
   * strictly capped to early chapters so spoilers don't leak into
   * prompts for the opening pages.
   */
  book_summary?: string | null;
  /**
   * Per-project toggles controlling which optional blocks are
   * included in the translator prompt. Powers the Project Settings →
   * Prompt options card and the live prompt simulator. The validator
   * still enforces locked glossary terms regardless of these toggles
   * — the glossary block itself is intentionally not toggleable.
   *
   * Pre-existing rows missing this field fall back to
   * {@link DEFAULT_PROMPT_OPTIONS} (everything on).
   */
  prompt_options?: PromptOptions | null;
}

/**
 * Per-project knobs controlling translator-prompt composition.
 *
 * Each flag toggles whether the corresponding block is emitted in
 * either the system message (the cacheable prefix) or the user
 * message (the volatile per-segment tail). Wrapping content in XML
 * tags keeps the LLM's job unambiguous while letting the curator
 * trade off cost / context coverage from the Settings card.
 *
 * The glossary block is intentionally absent — it's the validator's
 * contract; sending without it just generates more flagged segments,
 * which is rarely the desired knob.
 */
export interface PromptOptions {
  /** Inject the project-level `<language_notes>` block. */
  include_language_notes: boolean;
  /** Inject the project-level `<style_guide>` block. */
  include_style_guide: boolean;
  /** Inject the project-level `<book_summary>` block. */
  include_book_summary: boolean;
  /** Inject the `<target_only_terms>` warning block. */
  include_target_only: boolean;
  /** Inject the per-chapter `<chapter_notes>` block. */
  include_chapter_notes: boolean;
  /** Inject the per-segment `<proposed_terms>` hint block. */
  include_proposed_hints: boolean;
  /**
   * Inject the per-segment `<recent_context>` block. Still gated by
   * `context_mode` and `context_max_segments` — turning this off is a
   * hard override that skips the block even when the project's
   * context window is non-empty.
   */
  include_recent_context: boolean;
}

/**
 * Defaults applied when a `ProjectRow` has no `prompt_options` field
 * (legacy rows) or when individual flags are missing. Every block is
 * on by default — the simulator + tooltips warn the curator before
 * turning anything off.
 */
export const DEFAULT_PROMPT_OPTIONS: PromptOptions = {
  include_language_notes: true,
  include_style_guide: true,
  include_book_summary: true,
  include_target_only: true,
  include_chapter_notes: true,
  include_proposed_hints: true,
  include_recent_context: true,
};

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
  /** translate | translate_group | extract | extract_target | review | tone_sniff | embedding … */
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
  /**
   * Wall-clock duration of the provider call, in milliseconds. `null`
   * for cache-hit replays (no network round-trip happened) and for
   * legacy rows written before the column was introduced. Surfaced in
   * the LLM Activity screen so curators can spot slow models / large
   * embedding batches at a glance. Non-indexed — Dexie ignores it for
   * legacy reads, which return `undefined`.
   */
  duration_ms?: number | null;
}

export interface EmbeddingRow {
  id: string;
  /**
   * Scope discriminator. The same table lives in both per-project DBs
   * (`segment` + `glossary_entry`) and per-Lore-Book DBs (just
   * `glossary_entry`). The plan refers to these conceptually as
   * `segment_embeddings`, `glossary_entry_embeddings`, and
   * `lore_glossary_embeddings`; physically they share one Dexie table
   * to keep migrations boring and the cosine-top-K helper
   * polymorphic.
   */
  scope: "segment" | "glossary_entry";
  /** `segments.id` for `scope="segment"`, `glossary_entries.id` otherwise. */
  ref_id: string;
  /** Model slug — the same `(scope, ref_id)` key may carry multiple model rows. */
  model: string;
  /** Vector dimensionality (must equal `vector.byteLength / 4`). */
  dim: number;
  /** Packed `Float32Array` (`packFloat32(vec)`); see `@/llm/embeddings/base`. */
  vector: Uint8Array;
  /** When the row was written (ms since epoch). Used for incremental backfill. */
  created_at: number;
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
  /**
   * Embedding-retrieval overrides applied when the project's
   * embedding provider is enabled. Pre-existing rows missing these
   * fields fall back to the global defaults (top_k=16, min_sim=0.7).
   *
   * - `null` for both means "flatten the entire Lore Book into the
   *   prompt" (legacy behaviour, matches `provider="none"` projects).
   * - Setting `top_k` to a positive integer caps the number of
   *   entries injected; the rest are dropped.
   * - `min_similarity` filters cosine values below the threshold;
   *   raises precision at the cost of recall.
   */
  retrieval_top_k?: number | null;
  retrieval_min_similarity?: number | null;
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

/**
 * Persisted snapshot of the curator's in-flight batch run.
 *
 * Why this lives in the library DB even though batch progress is
 * "process state": when the curator hits refresh mid-translation we
 * want to (a) repaint the BatchStatusBar identically before the React
 * tree mounts, and (b) auto-resume the runner against the same input
 * so the wall-clock cost of the refresh is just the network round-
 * trip for a few in-flight segments. Rebuilding either of those from
 * `events`/`segments` alone would lose the curator-visible meter
 * totals (the original `pending.length` snapshot at start) and force
 * a stutter where the bar disappears and re-appears.
 *
 * Singleton row, key = "batch". Cleared by `useBatchStore.dismiss()`
 * once the curator acknowledges a finished batch — same UX as before
 * the persisted layer was added.
 *
 * Cross-tab safety:
 *
 * - The owner tab writes its `owner_session_id` and refreshes
 *   `heartbeat_ms` every ~2 s while the run is active.
 * - On `pagehide` the owner clears `owner_session_id` so a refresh
 *   in the same tab takes ownership immediately on the next boot
 *   (no need to wait for heartbeat to go stale).
 * - A second tab opened while the first is mid-batch sees a fresh
 *   heartbeat and politely mirrors instead of competing for IDB
 *   writes; if the owner dies hard, the heartbeat eventually goes
 *   stale and the mirror tab takes over.
 */
export interface LibraryBatchStateRow {
  /** Singleton row, key = "batch". */
  key: "batch";
  active: PersistedActiveBatch | null;
  queue: PersistedQueuedBatch[];
}

/**
 * Subset of `StartBatchInput` (see `src/hooks/useRunBatch.ts`) that
 * survives a JSON round-trip through Dexie. Fields are kept
 * non-optional with nullable defaults so a hand-edited Dexie row
 * round-trips without the runner having to re-clamp every field.
 */
export interface PersistedBatchInput {
  project_id: string;
  budget_usd: number | null;
  concurrency: number;
  bypass_cache: boolean;
  chapter_ids: readonly string[] | null;
  pre_pass: boolean;
}

/**
 * Mirror of `core/batch.BatchSummary` shaped for storage. Identical
 * field set; declared here so `src/db/schema.ts` doesn't import from
 * `src/core/*` (preserves the persistence-layer's "no behaviour
 * imports" rule).
 */
export interface PersistedBatchSummary {
  translated: number;
  cached: number;
  flagged: number;
  failed: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  elapsed_s: number;
  total: number;
  paused_reason: string | null;
  failures: Array<{ segment_id: string; error: string }>;
}

export interface PersistedActiveBatch {
  project_id: string;
  project_name: string;
  started_at: number;
  /** Curator-submitted input; replayed on auto-resume. */
  input: PersistedBatchInput;
  /** Latest progress snapshot the BatchStatusBar should re-paint. */
  summary: PersistedBatchSummary;
  /**
   * Lifecycle of the persisted run.
   *
   * - `running` — a tab is (or was) actively driving the work. Auto-
   *   resume kicks in if the heartbeat is stale or the owner cleared
   *   itself on `pagehide`.
   * - `completed` / `cancelled` / `paused` — terminal display state.
   *   The bar still shows it until the curator dismisses; refresh
   *   keeps showing the same final tally.
   */
  status: "running" | "completed" | "cancelled" | "paused";
  paused_reason: string | null;
  /**
   * Owner tab's session id. Cleared on `pagehide` so a refresh in
   * the same tab takes over on next boot without waiting for the
   * heartbeat to expire. `null` ⇒ "no live owner, safe to claim".
   */
  owner_session_id: string | null;
  /** Wall-clock ms of the most recent heartbeat from the owner tab. */
  heartbeat_ms: number;
}

export interface PersistedQueuedBatch {
  id: string;
  project_id: string;
  project_name: string;
  enqueued_at: number;
  label: string;
  input: PersistedBatchInput;
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
  /**
   * `reasoning_effort` controls thinking/chain-of-thought intensity
   * on capable models. Five recognized values:
   *
   * - `"minimal" | "low" | "medium" | "high"` — OpenAI o-series
   *   convention; cloud models ignore unrecognized values.
   * - `"none"` — Ollama-compat extension that *disables* thinking on
   *   thinking-capable models (Qwen 3, DeepSeek-R1, Gemma 3 thinking,
   *   GPT-OSS reasoning). See
   *   https://github.com/ollama/ollama/issues/14820. Cloud providers
   *   that don't recognise `"none"` silently fall back to their
   *   default, so it's safe to leave on across a model swap.
   * - `null` — provider default (no `reasoning_effort` field sent).
   *
   * Note: thinking-capable models often add latency proportional to
   * the effort level. Translation work usually doesn't benefit from
   * `medium`/`high`; `low` or `none` is the sweet spot.
   */
  reasoning_effort: "minimal" | "low" | "medium" | "high" | "none" | null;
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
  /**
   * Embedding-provider configuration (default `"none"`). The
   * embedding layer powers Lore-Book retrieval, the `relevant` cross-
   * chapter context mode, and proposed-entry hints. Pre-existing rows
   * missing this field implicitly behave as if `provider = "none"`.
   */
  embedding?: LibraryEmbeddingConfig;
  /**
   * Optional Ollama-specific runtime options forwarded as a top-level
   * `options` object on every chat-completion request. Cloud
   * providers ignore the unknown body field; Ollama maps the values
   * onto its native Modelfile knobs (`num_ctx`, `num_predict`,
   * `temperature`, etc.). See `src/llm/ollama.ts` for the full list,
   * defaults, and the Settings → Ollama options card. `null` /
   * missing means "send no overrides", which is the default for
   * pre-existing rows.
   *
   * Stored as the runtime `OllamaOptions` shape (every value optional
   * + numeric) so the field round-trips without a structural cast.
   * `sanitizeOllamaOptions` re-clamps on read/write so a hand-edited
   * Dexie row never reaches the wire with garbage.
   */
  ollama_options?: OllamaOptionsLike | null;
  /**
   * Per-request timeout (milliseconds). When a single chat-completion
   * call exceeds this, the provider aborts the in-flight `fetch`,
   * surfaces a typed timeout error, and the retry policy decides
   * whether to try again. Pre-existing rows fall back to the
   * provider's default (60 s, see `OpenAICompatProvider.timeout_ms`)
   * — but local Ollama with a thinking-capable model on a chapter-
   * sized prompt comfortably exceeds that, so the Settings card
   * defaults new rows to a more generous 180 s.
   */
  timeout_ms?: number | null;
  /**
   * Batch-level reliability knobs. Distinct from the per-request
   * provider retry (which handles transient HTTP 5xx / 429 / network
   * blips inside a single chat call): once a segment exhausts the
   * provider retries and bubbles a failure, the *batch* layer
   * decides whether to (a) retry the segment again from scratch and
   * (b) trip a circuit breaker if too many segments fail in a row.
   *
   * Pre-existing rows are missing this field; the batch runner falls
   * back to the documented defaults (see `BATCH_RETRY_DEFAULTS` in
   * `src/core/batch.ts`).
   */
  batch_retry?: BatchRetryConfig | null;
}

/**
 * Batch-runner retry / circuit-breaker config. All fields optional;
 * `runBatch` clamps and falls back to `BATCH_RETRY_DEFAULTS` for any
 * missing or invalid value. Lives in the persistence layer (rather
 * than `core/batch.ts`) so a hand-edited Dexie row round-trips
 * cleanly across the type system.
 */
export interface BatchRetryConfig {
  /**
   * Extra retry attempts at the batch level *after* the provider's
   * own retry policy has given up on a segment. `0` disables batch
   * retries entirely (only the provider retries inside a single
   * call). `2` (the default) gives each segment 1 normal try + 2
   * full retries before recording a failure.
   */
  max_retries_per_segment?: number;
  /**
   * Sliding window size (number of most-recent settled segments) the
   * circuit breaker watches. Must be at least 1. The breaker
   * compares failures *within this window* against
   * `max_errors_in_window`.
   */
  error_window_size?: number;
  /**
   * Failure threshold inside the sliding window. When the count of
   * failed segments in the last `error_window_size` settled segments
   * exceeds this, the batch pauses with a `BatchPaused` error and
   * the curator can fix the root cause (CORS, model unloaded,
   * timeout too tight) before resuming.
   */
  max_errors_in_window?: number;
}

/**
 * Persisted shape for Ollama runtime options. Mirrors `OllamaOptions`
 * in `src/llm/ollama.ts` but lives here so `db/schema.ts` doesn't
 * depend on `@/llm/*` (preserves the persistence-layer's "no
 * behaviour imports" rule). Mixed-type field — most values are
 * numbers (Modelfile knobs); `think` is a top-level boolean.
 */
export interface OllamaOptionsLike {
  num_ctx?: number;
  num_predict?: number;
  temperature?: number;
  top_k?: number;
  top_p?: number;
  repeat_penalty?: number;
  seed?: number;
  mirostat?: number;
  mirostat_eta?: number;
  mirostat_tau?: number;
  think?: boolean;
}

/**
 * Embedding-provider knobs (mirrors how `pricing_overrides` is keyed
 * off the same singleton row).
 *
 * - `provider: "none"` — embeddings disabled. Translation behaves
 *   exactly as in v1: locked + confirmed glossary entries, no Lore
 *   retrieval, no cross-chapter `relevant` context, no proposed hints.
 * - `provider: "openai-compat"` — uses the configured `base_url` /
 *   `api_key` (or per-field overrides) and posts to `/v1/embeddings`.
 * - `provider: "local"` — `@xenova/transformers` running on-device.
 *   The first activation downloads the model from `huggingface.co`
 *   after explicit curator consent.
 */
export interface LibraryEmbeddingConfig {
  provider: "none" | "openai-compat" | "local";
  model: string;
  dim: number;
  batch_size: number;
  /** Optional per-embedding endpoint overrides; falls back to the LLM endpoint. */
  base_url?: string | null;
  api_key?: string | null;
  /** USD per million input tokens (output tokens are always 0 for embeddings). */
  price_per_mtok?: number | null;
}

export const DEFAULT_EMBEDDING_CONFIG: LibraryEmbeddingConfig = {
  provider: "none",
  model: "text-embedding-3-small",
  dim: 1536,
  batch_size: 64,
  base_url: null,
  api_key: null,
  price_per_mtok: null,
};

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
