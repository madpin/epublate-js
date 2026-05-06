import { describe, expect, it } from "vitest";

import {
  applyPromptOptionOverrides,
  resolvePromptOptions,
} from "./prompt_options";
import { DEFAULT_PROMPT_OPTIONS } from "@/db/schema";

describe("resolvePromptOptions", () => {
  it("returns documented defaults for null / undefined", () => {
    expect(resolvePromptOptions(null)).toEqual(DEFAULT_PROMPT_OPTIONS);
    expect(resolvePromptOptions(undefined)).toEqual(DEFAULT_PROMPT_OPTIONS);
  });

  it("fills in missing fields with defaults", () => {
    const out = resolvePromptOptions({
      include_proposed_hints: false,
      include_recent_context: false,
    });
    expect(out.include_proposed_hints).toBe(false);
    expect(out.include_recent_context).toBe(false);
    expect(out.include_language_notes).toBe(true);
    expect(out.include_style_guide).toBe(true);
    expect(out.include_book_summary).toBe(true);
    expect(out.include_target_only).toBe(true);
    expect(out.include_chapter_notes).toBe(true);
  });

  it("coerces non-boolean values back to defaults", () => {
    const out = resolvePromptOptions({
      include_book_summary: "yes" as unknown as boolean,
      include_chapter_notes: 0 as unknown as boolean,
    });
    expect(out.include_book_summary).toBe(
      DEFAULT_PROMPT_OPTIONS.include_book_summary,
    );
    expect(out.include_chapter_notes).toBe(
      DEFAULT_PROMPT_OPTIONS.include_chapter_notes,
    );
  });

  it("does not mutate the input object", () => {
    const input = { include_proposed_hints: false } as const;
    const out = resolvePromptOptions(input);
    expect(out.include_proposed_hints).toBe(false);
    expect(Object.keys(input)).toEqual(["include_proposed_hints"]);
  });
});

describe("applyPromptOptionOverrides", () => {
  it("flips individual flags without persisting", () => {
    const base = resolvePromptOptions(null);
    const out = applyPromptOptionOverrides(base, {
      include_recent_context: false,
    });
    expect(out.include_recent_context).toBe(false);
    expect(base.include_recent_context).toBe(true);
  });

  it("returns a fresh copy when overrides are empty", () => {
    const base = resolvePromptOptions(null);
    const out = applyPromptOptionOverrides(base, null);
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
  });
});
