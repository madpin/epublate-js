import { afterEach, describe, expect, it } from "vitest";

import { createSummary, type BatchSummary } from "@/core/batch";
import {
  clearBatchState,
  libraryDb,
  readBatchState,
  releaseBatchOwnership,
  resetLibraryDbCache,
  touchBatchHeartbeat,
} from "@/db/library";
import {
  fromPersistedActive,
  fromPersistedQueued,
  installBatchStatePersistence,
  PERSIST_THROTTLE_MS,
  toPersistedActive,
  toPersistedQueued,
  uninstallBatchStatePersistence,
  HEARTBEAT_STALE_MS,
  SESSION_ID,
} from "@/state/batch_persist";
import { useBatchStore } from "@/state/batch";

const SAMPLE_INPUT = {
  project_id: "proj1",
  budget_usd: 0.5,
  concurrency: 4,
  bypass_cache: false,
  chapter_ids: ["ch1", "ch2"] as readonly string[],
  pre_pass: true,
};

/**
 * Wait long enough for the persistence throttle to fire its next
 * write. Using real wall-clock sleeps because Dexie + fake-indexeddb
 * don't survive `vi.useFakeTimers()` cleanly.
 */
function flushThrottle(): Promise<void> {
  return new Promise((r) => setTimeout(r, PERSIST_THROTTLE_MS + 50));
}

afterEach(async () => {
  uninstallBatchStatePersistence();
  useBatchStore.setState({ active: null, queue: [] });
  await libraryDb().delete();
  resetLibraryDbCache();
});

describe("toPersistedActive / fromPersistedActive round trip", () => {
  it("preserves every field except the AbortController", () => {
    const controller = new AbortController();
    const summary: BatchSummary = {
      ...createSummary(),
      translated: 7,
      cached: 1,
      flagged: 0,
      failed: 1,
      cost_usd: 0.0123,
      total: 12,
      elapsed_s: 5.5,
      failures: [{ segment_id: "seg-9", error: "boom" }],
    };
    const persisted = toPersistedActive({
      project_id: "p",
      project_name: "Project P",
      started_at: 1000,
      input: SAMPLE_INPUT,
      summary,
      controller,
      finished: false,
      paused_reason: null,
      final_status: null,
    });
    expect(persisted.project_id).toBe("p");
    expect(persisted.input).toEqual(SAMPLE_INPUT);
    expect(persisted.summary.failures).toEqual([
      { segment_id: "seg-9", error: "boom" },
    ]);
    expect(persisted.status).toBe("running");
    expect(persisted.owner_session_id).toBe(SESSION_ID);

    const back = fromPersistedActive(persisted);
    expect(back.project_id).toBe("p");
    expect(back.input).toEqual(SAMPLE_INPUT);
    expect(back.summary.translated).toBe(7);
    expect(back.summary.failures).toEqual([
      { segment_id: "seg-9", error: "boom" },
    ]);
    expect(back.controller).toBeInstanceOf(AbortController);
    expect(back.controller).not.toBe(controller); // fresh instance
    expect(back.finished).toBe(false);
    expect(back.final_status).toBeNull();
  });

  it("maps a finished active row to finished=true with a final_status", () => {
    const persisted = toPersistedActive({
      project_id: "p",
      project_name: "P",
      started_at: 1,
      input: SAMPLE_INPUT,
      summary: createSummary(),
      controller: new AbortController(),
      finished: true,
      paused_reason: "budget cap",
      final_status: "paused",
    });
    expect(persisted.status).toBe("paused");
    expect(persisted.owner_session_id).toBeNull();

    const back = fromPersistedActive(persisted);
    expect(back.finished).toBe(true);
    expect(back.final_status).toBe("paused");
    expect(back.paused_reason).toBe("budget cap");
  });
});

describe("toPersistedQueued / fromPersistedQueued", () => {
  it("normalises the opaque input shape so legacy rows round-trip", () => {
    const persisted = toPersistedQueued({
      id: "q1",
      project_id: "p",
      project_name: "P",
      enqueued_at: 99,
      label: "1 chapter",
      input: { project_id: "p", concurrency: 8 },
    });
    expect(persisted.input.project_id).toBe("p");
    expect(persisted.input.concurrency).toBe(8);
    expect(persisted.input.budget_usd).toBeNull();
    expect(persisted.input.bypass_cache).toBe(false);
    expect(persisted.input.chapter_ids).toBeNull();
    expect(persisted.input.pre_pass).toBe(false);

    const back = fromPersistedQueued(persisted);
    expect(back.id).toBe("q1");
    expect(back.label).toBe("1 chapter");
  });
});

describe("installBatchStatePersistence", () => {
  it("clears the persisted row when the store is empty", async () => {
    // Seed a non-empty row so we can prove the empty store wipes it.
    await libraryDb().batch_state.put({
      key: "batch",
      active: null,
      queue: [
        {
          id: "stale",
          project_id: "p",
          project_name: "P",
          enqueued_at: 1,
          label: "x",
          input: {
            project_id: "p",
            budget_usd: null,
            concurrency: 1,
            bypass_cache: false,
            chapter_ids: null,
            pre_pass: false,
          },
        },
      ],
    });
    installBatchStatePersistence();
    await flushThrottle();
    const row = await readBatchState();
    expect(row.active).toBeNull();
    expect(row.queue).toEqual([]);
  });

  it("persists the active batch on store.start()", async () => {
    installBatchStatePersistence();
    useBatchStore.getState().start({
      project_id: "p",
      project_name: "Project P",
      input: SAMPLE_INPUT,
      summary: createSummary(),
      controller: new AbortController(),
    });
    await flushThrottle();
    const row = await readBatchState();
    expect(row.active).not.toBeNull();
    expect(row.active!.project_id).toBe("p");
    expect(row.active!.input).toEqual(SAMPLE_INPUT);
    expect(row.active!.status).toBe("running");
    expect(row.active!.owner_session_id).toBe(SESSION_ID);
  });

  it("flips status to the final_status on store.finish()", async () => {
    installBatchStatePersistence();
    useBatchStore.getState().start({
      project_id: "p",
      project_name: "Project P",
      input: SAMPLE_INPUT,
      summary: createSummary(),
      controller: new AbortController(),
    });
    useBatchStore.getState().finish({
      summary: { ...createSummary(), translated: 5 },
      final_status: "completed",
    });
    await flushThrottle();
    const row = await readBatchState();
    expect(row.active!.status).toBe("completed");
    expect(row.active!.summary.translated).toBe(5);
    expect(row.active!.owner_session_id).toBeNull();
  });

  it("clears the persisted row on store.dismiss()", async () => {
    installBatchStatePersistence();
    useBatchStore.getState().start({
      project_id: "p",
      project_name: "Project P",
      input: SAMPLE_INPUT,
      summary: createSummary(),
      controller: new AbortController(),
    });
    await flushThrottle();
    expect((await readBatchState()).active).not.toBeNull();

    useBatchStore.getState().dismiss();
    await flushThrottle();
    const row = await readBatchState();
    expect(row.active).toBeNull();
    expect(row.queue).toEqual([]);
  });
});

describe("touchBatchHeartbeat", () => {
  it("updates only owner_session_id and heartbeat_ms", async () => {
    await libraryDb().batch_state.put({
      key: "batch",
      active: {
        project_id: "p",
        project_name: "Project P",
        started_at: 100,
        input: {
          project_id: "p",
          budget_usd: null,
          concurrency: 1,
          bypass_cache: false,
          chapter_ids: null,
          pre_pass: false,
        },
        summary: {
          translated: 1,
          cached: 0,
          flagged: 0,
          failed: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0,
          elapsed_s: 0,
          total: 4,
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

    await touchBatchHeartbeat({
      owner_session_id: "tab-A",
      heartbeat_ms: 555,
    });
    const row = await readBatchState();
    expect(row.active!.owner_session_id).toBe("tab-A");
    expect(row.active!.heartbeat_ms).toBe(555);
    expect(row.active!.summary.translated).toBe(1); // untouched
  });

  it("is a no-op once the row has flipped to a terminal status", async () => {
    await libraryDb().batch_state.put({
      key: "batch",
      active: {
        project_id: "p",
        project_name: "Project P",
        started_at: 100,
        input: {
          project_id: "p",
          budget_usd: null,
          concurrency: 1,
          bypass_cache: false,
          chapter_ids: null,
          pre_pass: false,
        },
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
        status: "completed",
        paused_reason: null,
        owner_session_id: null,
        heartbeat_ms: 100,
      },
      queue: [],
    });
    await touchBatchHeartbeat({
      owner_session_id: "tab-A",
      heartbeat_ms: 999,
    });
    const row = await readBatchState();
    expect(row.active!.heartbeat_ms).toBe(100);
    expect(row.active!.owner_session_id).toBeNull();
  });
});

describe("releaseBatchOwnership", () => {
  it("clears owner_session_id without touching anything else", async () => {
    await libraryDb().batch_state.put({
      key: "batch",
      active: {
        project_id: "p",
        project_name: "P",
        started_at: 1,
        input: {
          project_id: "p",
          budget_usd: null,
          concurrency: 1,
          bypass_cache: false,
          chapter_ids: null,
          pre_pass: false,
        },
        summary: {
          translated: 3,
          cached: 0,
          flagged: 0,
          failed: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0,
          elapsed_s: 0,
          total: 5,
          paused_reason: null,
          failures: [],
        },
        status: "running",
        paused_reason: null,
        owner_session_id: "tab-A",
        heartbeat_ms: 5_000,
      },
      queue: [],
    });

    await releaseBatchOwnership();

    const row = await readBatchState();
    expect(row.active!.owner_session_id).toBeNull();
    expect(row.active!.heartbeat_ms).toBe(5_000); // preserved
    expect(row.active!.summary.translated).toBe(3); // preserved
  });

  it("is a no-op when no row exists", async () => {
    await clearBatchState();
    await releaseBatchOwnership();
    const row = await readBatchState();
    expect(row.active).toBeNull();
  });
});

describe("HEARTBEAT_STALE_MS", () => {
  it("is greater than the heartbeat interval so a single missed beat doesn't trip claim", () => {
    expect(HEARTBEAT_STALE_MS).toBeGreaterThanOrEqual(4_000);
  });
});
