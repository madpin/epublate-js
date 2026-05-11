import { describe, expect, it } from "vitest";

import {
  LLM_PRESETS,
  findLlmPreset,
  hasLlmEnvDefaults,
  readLlmEnvDefaults,
} from "./env_defaults";

describe("readLlmEnvDefaults", () => {
  it("returns an empty object when no VITE_EPUBLATE_LLM_* vars are set", () => {
    expect(readLlmEnvDefaults({})).toEqual({});
    expect(
      readLlmEnvDefaults({
        VITE_OTHER_VAR: "ignored",
        VITE_EPUBLATE_LLM_BASE_URL: "",
        VITE_EPUBLATE_LLM_MODEL: "   ",
      }),
    ).toEqual({});
  });

  it("trims string values and drops empty fields", () => {
    expect(
      readLlmEnvDefaults({
        VITE_EPUBLATE_LLM_BASE_URL: "  https://api.openai.com/v1  ",
        VITE_EPUBLATE_LLM_API_KEY: "sk-abc\n",
        VITE_EPUBLATE_LLM_MODEL: "gpt-5-mini",
        VITE_EPUBLATE_LLM_HELPER_MODEL: "",
      }),
    ).toEqual({
      base_url: "https://api.openai.com/v1",
      api_key: "sk-abc",
      model: "gpt-5-mini",
    });
  });

  it("only accepts reasoning_effort values in the allowed enum", () => {
    expect(
      readLlmEnvDefaults({ VITE_EPUBLATE_LLM_REASONING_EFFORT: "low" }),
    ).toEqual({ reasoning_effort: "low" });
    expect(
      readLlmEnvDefaults({ VITE_EPUBLATE_LLM_REASONING_EFFORT: "none" }),
    ).toEqual({ reasoning_effort: "none" });
    expect(
      readLlmEnvDefaults({ VITE_EPUBLATE_LLM_REASONING_EFFORT: "extreme" }),
    ).toEqual({});
  });

  it("parses timeout_ms as a positive integer", () => {
    expect(
      readLlmEnvDefaults({ VITE_EPUBLATE_LLM_TIMEOUT_MS: "180000" }),
    ).toEqual({ timeout_ms: 180000 });
    expect(
      readLlmEnvDefaults({ VITE_EPUBLATE_LLM_TIMEOUT_MS: "0" }),
    ).toEqual({});
    expect(
      readLlmEnvDefaults({ VITE_EPUBLATE_LLM_TIMEOUT_MS: "-50" }),
    ).toEqual({});
    expect(
      readLlmEnvDefaults({ VITE_EPUBLATE_LLM_TIMEOUT_MS: "lots" }),
    ).toEqual({});
    expect(
      readLlmEnvDefaults({ VITE_EPUBLATE_LLM_TIMEOUT_MS: "12.7" }),
    ).toEqual({ timeout_ms: 13 });
  });

  it("captures organization, helper_model, and api_key together", () => {
    expect(
      readLlmEnvDefaults({
        VITE_EPUBLATE_LLM_BASE_URL: "https://openrouter.ai/api/v1",
        VITE_EPUBLATE_LLM_API_KEY: "sk-or-…",
        VITE_EPUBLATE_LLM_MODEL: "openai/gpt-5-mini",
        VITE_EPUBLATE_LLM_HELPER_MODEL: "openai/gpt-5-nano",
        VITE_EPUBLATE_LLM_ORGANIZATION: "org-42",
        VITE_EPUBLATE_LLM_REASONING_EFFORT: "low",
        VITE_EPUBLATE_LLM_TIMEOUT_MS: "120000",
      }),
    ).toEqual({
      base_url: "https://openrouter.ai/api/v1",
      api_key: "sk-or-…",
      model: "openai/gpt-5-mini",
      helper_model: "openai/gpt-5-nano",
      organization: "org-42",
      reasoning_effort: "low",
      timeout_ms: 120000,
    });
  });
});

describe("hasLlmEnvDefaults", () => {
  it("returns false for an empty object", () => {
    expect(hasLlmEnvDefaults({})).toBe(false);
  });

  it("returns true when any key is present", () => {
    expect(hasLlmEnvDefaults({ model: "gpt-5-mini" })).toBe(true);
    expect(hasLlmEnvDefaults({ base_url: "" })).toBe(true);
  });
});

describe("LLM_PRESETS", () => {
  it("exposes the three documented presets in a stable order", () => {
    expect(LLM_PRESETS.map((p) => p.id)).toEqual([
      "openai",
      "openrouter",
      "ollama",
    ]);
  });

  it("provides a base_url + model for every preset", () => {
    for (const preset of LLM_PRESETS) {
      expect(preset.base_url).toMatch(/^https?:\/\/.+/);
      expect(preset.model.trim().length).toBeGreaterThan(0);
      expect(preset.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it("findLlmPreset returns the matching preset or undefined", () => {
    expect(findLlmPreset("openai")?.base_url).toBe("https://api.openai.com/v1");
    expect(findLlmPreset("ollama")?.base_url).toBe(
      "http://localhost:11434/v1",
    );
    // @ts-expect-error — exercises the runtime guard.
    expect(findLlmPreset("nope")).toBeUndefined();
  });
});
