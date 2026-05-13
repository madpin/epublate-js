import { afterEach, describe, it, expect } from "vitest";

import {
  clearBatchState,
  DEFAULT_LLM_CONFIG,
  DEFAULT_UI_PREFS,
  EMPTY_BATCH_STATE,
  libraryDb,
  readBatchState,
  readLlmConfig,
  readUiPrefs,
  releaseBatchOwnership,
  resetLibraryDbCache,
  seedLlmConfigIfEmpty,
  touchBatchHeartbeat,
  writeBatchState,
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

describe("batch state helpers", () => {
  const SAMPLE_INPUT = {
    project_id: "p1",
    budget_usd: 0.25,
    concurrency: 2,
    bypass_cache: false,
    chapter_ids: ["ch1"] as readonly string[],
    pre_pass: false,
  };

  it("readBatchState returns EMPTY_BATCH_STATE when the row is missing", async () => {
    expect(await readBatchState()).toEqual(EMPTY_BATCH_STATE);
  });

  it("writeBatchState round-trips an active row", async () => {
    await writeBatchState({
      active: {
        project_id: "p1",
        project_name: "Project 1",
        started_at: 100,
        input: SAMPLE_INPUT,
        summary: {
          translated: 3,
          cached: 0,
          flagged: 0,
          failed: 0,
          prompt_tokens: 10,
          completion_tokens: 20,
          cost_usd: 0.001,
          elapsed_s: 1.5,
          total: 5,
          paused_reason: null,
          failures: [],
        },
        status: "running",
        paused_reason: null,
        owner_session_id: "tab-A",
        heartbeat_ms: 200,
      },
      queue: [],
    });
    const row = await readBatchState();
    expect(row.active!.project_name).toBe("Project 1");
    expect(row.active!.input).toEqual(SAMPLE_INPUT);
    expect(row.active!.summary.translated).toBe(3);
  });

  it("writeBatchState({active: null, queue: []}) clears the row", async () => {
    await writeBatchState({
      active: {
        project_id: "p1",
        project_name: "Project 1",
        started_at: 100,
        input: SAMPLE_INPUT,
        summary: {
          translated: 0,
          cached: 0,
          flagged: 0,
          failed: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0,
          elapsed_s: 0,
          total: 0,
          paused_reason: null,
          failures: [],
        },
        status: "running",
        paused_reason: null,
        owner_session_id: null,
        heartbeat_ms: 0,
      },
      queue: [],
    });
    await writeBatchState({ active: null, queue: [] });
    expect(await libraryDb().batch_state.get("batch")).toBeUndefined();
  });

  it("touchBatchHeartbeat / releaseBatchOwnership / clearBatchState compose", async () => {
    await writeBatchState({
      active: {
        project_id: "p1",
        project_name: "P1",
        started_at: 1,
        input: SAMPLE_INPUT,
        summary: {
          translated: 0,
          cached: 0,
          flagged: 0,
          failed: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0,
          elapsed_s: 0,
          total: 0,
          paused_reason: null,
          failures: [],
        },
        status: "running",
        paused_reason: null,
        owner_session_id: null,
        heartbeat_ms: 0,
      },
      queue: [],
    });

    await touchBatchHeartbeat({ owner_session_id: "tab-X", heartbeat_ms: 50 });
    let row = await readBatchState();
    expect(row.active!.owner_session_id).toBe("tab-X");
    expect(row.active!.heartbeat_ms).toBe(50);

    await releaseBatchOwnership();
    row = await readBatchState();
    expect(row.active!.owner_session_id).toBeNull();
    expect(row.active!.heartbeat_ms).toBe(50); // preserved

    await clearBatchState();
    expect(await readBatchState()).toEqual(EMPTY_BATCH_STATE);
  });
});
