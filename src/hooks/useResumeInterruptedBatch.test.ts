import { describe, expect, it } from "vitest";

import type { PersistedActiveBatch } from "@/db/schema";
import { HEARTBEAT_STALE_MS } from "@/state/batch_persist";

import { shouldClaimOwnership } from "./useResumeInterruptedBatch";

const NOW = 1_000_000;
const OUR_SESSION = "tab-A";

function active(
  patch: Partial<PersistedActiveBatch> = {},
): PersistedActiveBatch {
  return {
    project_id: "p",
    project_name: "P",
    started_at: 0,
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
    status: "running",
    paused_reason: null,
    owner_session_id: null,
    heartbeat_ms: NOW,
    ...patch,
  };
}

describe("shouldClaimOwnership", () => {
  const ctx = { now: NOW, our_session_id: OUR_SESSION };

  it("never claims a non-running row (terminal display state)", () => {
    expect(shouldClaimOwnership(active({ status: "completed" }), ctx)).toBe(
      false,
    );
    expect(shouldClaimOwnership(active({ status: "cancelled" }), ctx)).toBe(
      false,
    );
    expect(shouldClaimOwnership(active({ status: "paused" }), ctx)).toBe(
      false,
    );
  });

  it("claims when owner_session_id is null (pagehide cleared)", () => {
    expect(
      shouldClaimOwnership(active({ owner_session_id: null }), ctx),
    ).toBe(true);
  });

  it("claims when owner_session_id matches our tab (refresh)", () => {
    expect(
      shouldClaimOwnership(
        active({ owner_session_id: OUR_SESSION, heartbeat_ms: NOW }),
        ctx,
      ),
    ).toBe(true);
  });

  it("does NOT claim when another live tab is the owner", () => {
    expect(
      shouldClaimOwnership(
        active({ owner_session_id: "tab-B", heartbeat_ms: NOW - 1_000 }),
        ctx,
      ),
    ).toBe(false);
  });

  it("claims when the heartbeat is older than HEARTBEAT_STALE_MS (owner died)", () => {
    expect(
      shouldClaimOwnership(
        active({
          owner_session_id: "tab-B",
          heartbeat_ms: NOW - HEARTBEAT_STALE_MS - 1,
        }),
        ctx,
      ),
    ).toBe(true);
  });

  it("waits the full grace period before claiming a fresh sibling owner", () => {
    expect(
      shouldClaimOwnership(
        active({
          owner_session_id: "tab-B",
          heartbeat_ms: NOW - HEARTBEAT_STALE_MS + 1,
        }),
        ctx,
      ),
    ).toBe(false);
  });
});
