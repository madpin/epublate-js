/**
 * Unit coverage for `src/llm/ollama.ts`.
 *
 * Two contracts:
 *   1. `sanitizeOllamaOptions` always produces values within the
 *      documented ranges (and integer / enum coercion is sticky).
 *   2. `buildOllamaBodyExtras` returns either an empty object (so
 *      `Object.assign` is a no-op for non-Ollama providers) or
 *      a single `options` field carrying the sanitized blob.
 *   3. `looksLikeOllamaUrl` matches the obvious local installs and
 *      cleanly rejects the cloud endpoints.
 */

import { describe, expect, it } from "vitest";

import {
  buildOllamaBodyExtras,
  looksLikeOllamaUrl,
  OLLAMA_OPTION_FIELDS,
  OLLAMA_PRESETS,
  ollamaOptionField,
  sanitizeOllamaOptions,
} from "./ollama";

describe("sanitizeOllamaOptions", () => {
  it("returns null for empty / null input", () => {
    expect(sanitizeOllamaOptions(null)).toBeNull();
    expect(sanitizeOllamaOptions(undefined)).toBeNull();
    expect(sanitizeOllamaOptions({})).toBeNull();
  });

  it("strips out unknown keys silently", () => {
    const result = sanitizeOllamaOptions({
      num_ctx: 8192,
      // Hand-edited Dexie row could carry these — must not survive.
      // @ts-expect-error – intentional unknown key
      not_a_real_knob: 999,
    });
    expect(result).toEqual({ num_ctx: 8192 });
  });

  it("clamps values into the documented range", () => {
    const result = sanitizeOllamaOptions({
      num_ctx: 999_999_999,
      temperature: 5,
      top_p: -1,
    });
    expect(result?.num_ctx).toBe(131_072);
    expect(result?.temperature).toBe(2);
    expect(result?.top_p).toBe(0);
  });

  it("truncates non-integer values for integer fields", () => {
    const result = sanitizeOllamaOptions({
      num_ctx: 8192.7,
      top_k: 40.9,
    });
    expect(result?.num_ctx).toBe(8192);
    expect(result?.top_k).toBe(40);
  });

  it("rejects mirostat values outside {0, 1, 2}", () => {
    // The input type permits any number; the sanitizer narrows
    // mirostat back to the documented enum and drops anything else.
    const result = sanitizeOllamaOptions({ mirostat: 7 });
    expect(result).toBeNull();
  });

  it("drops NaN / Infinity values", () => {
    const result = sanitizeOllamaOptions({
      num_ctx: Number.NaN,
      num_predict: Number.POSITIVE_INFINITY,
      temperature: 0.3,
    });
    expect(result).toEqual({ temperature: 0.3 });
  });

  it("preserves boolean `think` (true / false), drops non-booleans", () => {
    expect(sanitizeOllamaOptions({ think: false })).toEqual({ think: false });
    expect(sanitizeOllamaOptions({ think: true })).toEqual({ think: true });
    // Non-boolean values are rejected (not coerced to false).
    expect(
      sanitizeOllamaOptions({
        // @ts-expect-error – exercising malformed input
        think: "false",
      }),
    ).toBeNull();
    expect(
      sanitizeOllamaOptions({
        // @ts-expect-error – exercising malformed input
        think: 0,
      }),
    ).toBeNull();
  });
});

describe("buildOllamaBodyExtras", () => {
  it("returns {} when no overrides are configured", () => {
    expect(buildOllamaBodyExtras(null)).toEqual({});
    expect(buildOllamaBodyExtras({})).toEqual({});
  });

  it("nests the sanitized blob under `options`", () => {
    const extras = buildOllamaBodyExtras({
      num_ctx: 8192,
      // The sanitizer should drop this NaN.
      // @ts-expect-error – exercising malformed input
      top_p: "garbage",
    });
    expect(extras).toEqual({ options: { num_ctx: 8192 } });
  });

  it("places `think` at the top level (NOT inside `options`)", () => {
    expect(buildOllamaBodyExtras({ think: false })).toEqual({ think: false });
    expect(buildOllamaBodyExtras({ think: true })).toEqual({ think: true });
  });

  it("splits Modelfile knobs and top-level fields when both are set", () => {
    const extras = buildOllamaBodyExtras({
      num_ctx: 8192,
      temperature: 0.3,
      think: false,
    });
    expect(extras).toEqual({
      options: { num_ctx: 8192, temperature: 0.3 },
      think: false,
    });
  });
});

describe("looksLikeOllamaUrl", () => {
  it.each([
    ["http://localhost:11434/v1", true],
    ["https://ollama.example.com/v1", true],
    ["http://my-ollama:11434", true],
    ["https://api.openai.com/v1", false],
    ["https://openrouter.ai/api/v1", false],
    [null, false],
    [undefined, false],
    ["", false],
  ])("classifies %s as %s", (url, expected) => {
    expect(looksLikeOllamaUrl(url ?? null)).toBe(expected);
  });
});

describe("metadata invariants", () => {
  it("every preset only references known field keys", () => {
    const known_keys = new Set(OLLAMA_OPTION_FIELDS.map((f) => f.key));
    for (const preset of OLLAMA_PRESETS) {
      for (const key of Object.keys(preset.options)) {
        expect(known_keys.has(key as never)).toBe(true);
      }
    }
  });

  it("every preset's values survive sanitization round-trip unchanged", () => {
    for (const preset of OLLAMA_PRESETS) {
      const sane = sanitizeOllamaOptions(preset.options);
      expect(sane).toEqual(preset.options);
    }
  });

  it("ollamaOptionField returns metadata for every documented key", () => {
    for (const field of OLLAMA_OPTION_FIELDS) {
      expect(ollamaOptionField(field.key)).toBe(field);
    }
  });
});
