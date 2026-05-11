import { afterEach, describe, it, expect } from "vitest";

import {
  DEFAULT_LLM_CONFIG,
  DEFAULT_UI_PREFS,
  libraryDb,
  readLlmConfig,
  readUiPrefs,
  resetLibraryDbCache,
  seedLlmConfigIfEmpty,
  writeLlmConfig,
  writeUiPrefs,
} from "./library";

afterEach(async () => {
  await libraryDb().delete();
  resetLibraryDbCache();
});

describe("library DB", () => {
  it("returns defaults until the prefs/llm rows are written", async () => {
    expect(await readUiPrefs()).toEqual(DEFAULT_UI_PREFS);
    expect(await readLlmConfig()).toEqual(DEFAULT_LLM_CONFIG);
  });

  it("merges patches with existing rows", async () => {
    await writeUiPrefs({ theme: "textual-dark" });
    expect((await readUiPrefs()).theme).toBe("textual-dark");

    await writeLlmConfig({ model: "gpt-5-pro", api_key: "sk-test" });
    const llm = await readLlmConfig();
    expect(llm.model).toBe("gpt-5-pro");
    expect(llm.api_key).toBe("sk-test");
    expect(llm.base_url).toBe(DEFAULT_LLM_CONFIG.base_url);
  });
});

describe("seedLlmConfigIfEmpty", () => {
  it("writes the merged row when no LLM row exists yet", async () => {
    const { seeded, row } = await seedLlmConfigIfEmpty({
      base_url: "https://openrouter.ai/api/v1",
      api_key: "sk-or-…",
      model: "openai/gpt-5-mini",
    });
    expect(seeded).toBe(true);
    expect(row.base_url).toBe("https://openrouter.ai/api/v1");
    expect(row.api_key).toBe("sk-or-…");
    expect(row.model).toBe("openai/gpt-5-mini");
    // Unspecified fields stay at the hard-coded defaults.
    expect(row.helper_model).toBe(DEFAULT_LLM_CONFIG.helper_model);
    expect(row.timeout_ms).toBe(DEFAULT_LLM_CONFIG.timeout_ms);

    // The seed persists — a second call sees it and refuses to
    // overwrite curator-managed state.
    const second = await seedLlmConfigIfEmpty({
      base_url: "https://api.openai.com/v1",
    });
    expect(second.seeded).toBe(false);
    expect(second.row.base_url).toBe("https://openrouter.ai/api/v1");
  });

  it("never overwrites a Dexie row written by the curator", async () => {
    await writeLlmConfig({
      base_url: "https://api.openai.com/v1",
      api_key: "sk-keep",
      model: "gpt-5-pro",
    });
    const { seeded, row } = await seedLlmConfigIfEmpty({
      base_url: "https://openrouter.ai/api/v1",
      api_key: "sk-override",
      model: "openai/gpt-5-mini",
    });
    expect(seeded).toBe(false);
    expect(row.base_url).toBe("https://api.openai.com/v1");
    expect(row.api_key).toBe("sk-keep");
    expect(row.model).toBe("gpt-5-pro");
  });

  it("is a no-op when the patch is empty", async () => {
    const { seeded, row } = await seedLlmConfigIfEmpty({});
    expect(seeded).toBe(false);
    expect(row).toEqual(DEFAULT_LLM_CONFIG);
    // And nothing is persisted to Dexie.
    expect(await libraryDb().llm.get("llm")).toBeUndefined();
  });
});
