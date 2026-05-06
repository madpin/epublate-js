/**
 * Coverage for `resolveLlmConfig` — specifically the new
 * Ollama-options merge path. The library config is the baseline and
 * a project-level override layers on top *field-by-field* so a
 * project that wants to bump just `num_ctx` doesn't accidentally
 * drop the curator's other defaults.
 *
 * The non-Ollama resolution is exercised indirectly by the rest of
 * the suite via `buildProvider`; the focused tests below are
 * sufficient to lock the merge logic.
 */

import { describe, expect, it } from "vitest";

import { resolveLlmConfig } from "@/llm/factory";
import type { LibraryLlmConfigRow } from "@/db/schema";

const BASE_LIBRARY: LibraryLlmConfigRow = {
  key: "llm",
  base_url: "http://localhost:11434/v1",
  api_key: "",
  model: "llama3.2",
  helper_model: null,
  organization: null,
  reasoning_effort: null,
  pricing_overrides: {},
  ollama_options: null,
};

describe("resolveLlmConfig — ollama_options merge", () => {
  it("returns null when neither side specifies anything", () => {
    const resolved = resolveLlmConfig(BASE_LIBRARY, null);
    expect(resolved.ollama_options).toBeNull();
  });

  it("returns the library options when the project doesn't override", () => {
    const resolved = resolveLlmConfig({
      ...BASE_LIBRARY,
      ollama_options: { num_ctx: 8192, temperature: 0.3 },
    });
    expect(resolved.ollama_options).toEqual({
      num_ctx: 8192,
      temperature: 0.3,
    });
  });

  it("returns the project options when the library doesn't set any", () => {
    const resolved = resolveLlmConfig(BASE_LIBRARY, {
      ollama_options: { num_ctx: 16384 },
    });
    expect(resolved.ollama_options).toEqual({ num_ctx: 16384 });
  });

  it("layers project overrides on top of library defaults per-key", () => {
    const resolved = resolveLlmConfig(
      {
        ...BASE_LIBRARY,
        ollama_options: { num_ctx: 8192, temperature: 0.3, top_k: 40 },
      },
      {
        ollama_options: { num_ctx: 16384 },
      },
    );
    // num_ctx comes from the project; the rest from the library.
    expect(resolved.ollama_options).toEqual({
      num_ctx: 16384,
      temperature: 0.3,
      top_k: 40,
    });
  });

  it("clamps malformed library values during merge", () => {
    const resolved = resolveLlmConfig(
      {
        ...BASE_LIBRARY,
        // Hand-edited Dexie row with an out-of-range value.
        ollama_options: { num_ctx: 9_999_999, temperature: -1 },
      },
      null,
    );
    expect(resolved.ollama_options).toEqual({
      num_ctx: 131_072,
      temperature: 0,
    });
  });

  it("merges the boolean `think` field across library + project", () => {
    const resolved = resolveLlmConfig(
      {
        ...BASE_LIBRARY,
        ollama_options: { think: true, num_ctx: 8192 },
      },
      // Project flips `think` off for this run (e.g. faster batch).
      { ollama_options: { think: false } },
    );
    expect(resolved.ollama_options).toEqual({
      think: false,
      num_ctx: 8192,
    });
  });
});

describe("resolveLlmConfig — timeout_ms merge", () => {
  it("returns null when neither side sets a timeout", () => {
    const resolved = resolveLlmConfig(BASE_LIBRARY, null);
    expect(resolved.timeout_ms).toBeNull();
  });

  it("uses the library timeout when no project override exists", () => {
    const resolved = resolveLlmConfig({
      ...BASE_LIBRARY,
      timeout_ms: 180_000,
    });
    expect(resolved.timeout_ms).toBe(180_000);
  });

  it("project override wins over library default", () => {
    const resolved = resolveLlmConfig(
      { ...BASE_LIBRARY, timeout_ms: 60_000 },
      { timeout_ms: 240_000 },
    );
    expect(resolved.timeout_ms).toBe(240_000);
  });

  it("ignores non-positive / non-finite timeouts and falls through", () => {
    const resolved = resolveLlmConfig(
      { ...BASE_LIBRARY, timeout_ms: 90_000 },
      { timeout_ms: 0 },
    );
    expect(resolved.timeout_ms).toBe(90_000);
    const r2 = resolveLlmConfig(
      { ...BASE_LIBRARY, timeout_ms: -1 },
      { timeout_ms: Number.NaN },
    );
    expect(r2.timeout_ms).toBeNull();
  });
});

describe("resolveLlmConfig — reasoning_effort `none`", () => {
  it("propagates `none` from library to resolved config", () => {
    const resolved = resolveLlmConfig({
      ...BASE_LIBRARY,
      reasoning_effort: "none",
    });
    expect(resolved.reasoning_effort).toBe("none");
  });

  it("project override can flip reasoning_effort to `none`", () => {
    const resolved = resolveLlmConfig(
      { ...BASE_LIBRARY, reasoning_effort: "high" },
      { reasoning_effort: "none" },
    );
    expect(resolved.reasoning_effort).toBe("none");
  });
});
