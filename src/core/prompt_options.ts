/**
 * Helpers for the project-level {@link PromptOptions} blob.
 *
 * The persistence layer ({@link ProjectRow.prompt_options}) stores a
 * partial / nullable shape so legacy rows round-trip without
 * migration. Every read path runs through {@link resolvePromptOptions}
 * to fill in missing fields with the documented defaults — that way
 * the rest of the codebase only ever sees a fully-populated
 * `PromptOptions`.
 *
 * The `applyPromptOptionOverrides` helper layers a "what-if" patch on
 * top of the resolved options, used by the simulator and the
 * Reader-side preview panel without touching persistence.
 */

import {
  DEFAULT_PROMPT_OPTIONS,
  type PromptOptions,
} from "@/db/schema";

export type { PromptOptions } from "@/db/schema";
export { DEFAULT_PROMPT_OPTIONS } from "@/db/schema";

/**
 * Coerce a possibly-partial / nullable persisted shape into a
 * fully-populated {@link PromptOptions}. Unknown / extra fields are
 * dropped; missing booleans fall back to {@link DEFAULT_PROMPT_OPTIONS}.
 *
 * Accepts `null`, `undefined`, or `Partial<PromptOptions>` — the
 * Dexie row column is itself optional, so callers don't have to
 * branch on the read side.
 */
export function resolvePromptOptions(
  raw: Partial<PromptOptions> | null | undefined,
): PromptOptions {
  if (!raw) return { ...DEFAULT_PROMPT_OPTIONS };
  return {
    include_language_notes: bool(
      raw.include_language_notes,
      DEFAULT_PROMPT_OPTIONS.include_language_notes,
    ),
    include_style_guide: bool(
      raw.include_style_guide,
      DEFAULT_PROMPT_OPTIONS.include_style_guide,
    ),
    include_book_summary: bool(
      raw.include_book_summary,
      DEFAULT_PROMPT_OPTIONS.include_book_summary,
    ),
    include_target_only: bool(
      raw.include_target_only,
      DEFAULT_PROMPT_OPTIONS.include_target_only,
    ),
    include_chapter_notes: bool(
      raw.include_chapter_notes,
      DEFAULT_PROMPT_OPTIONS.include_chapter_notes,
    ),
    include_proposed_hints: bool(
      raw.include_proposed_hints,
      DEFAULT_PROMPT_OPTIONS.include_proposed_hints,
    ),
    include_recent_context: bool(
      raw.include_recent_context,
      DEFAULT_PROMPT_OPTIONS.include_recent_context,
    ),
  };
}

/**
 * Layer a "what-if" patch on top of a resolved {@link PromptOptions}.
 *
 * Used by the simulator and Reader preview to flip individual flags
 * without touching the persisted project row. Returns a fresh object
 * — never mutates the input.
 */
export function applyPromptOptionOverrides(
  base: PromptOptions,
  overrides: Partial<PromptOptions> | null | undefined,
): PromptOptions {
  if (!overrides) return { ...base };
  return resolvePromptOptions({ ...base, ...overrides });
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
