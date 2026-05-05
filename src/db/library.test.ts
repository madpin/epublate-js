import { describe, it, expect } from "vitest";

import {
  DEFAULT_LLM_CONFIG,
  DEFAULT_UI_PREFS,
  readLlmConfig,
  readUiPrefs,
  writeLlmConfig,
  writeUiPrefs,
} from "./library";

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
