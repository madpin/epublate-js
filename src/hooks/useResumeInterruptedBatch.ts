/**
 * `useResumeInterruptedBatch` — auto-resumes a batch interrupted by
 * a page refresh.
 *
 * Mounted once in `AppShell`. On the very first effect tick after
 * boot it inspects the persisted library row and decides one of:
 *
 * - **Nothing to do** — no row, or the row is already terminal
 *   (completed/cancelled/paused). The bootstrap path in `App.tsx`
 *   has already hydrated `useBatchStore` so the bar shows the right
 *   thing; we just leave it.
 * - **Take over** — status is `running` AND ownership is up for
 *   grabs (cleared by `pagehide`, or the heartbeat is older than
 *   {@link HEARTBEAT_STALE_MS}). We re-call `useRunBatch.start()`
 *   with the persisted input and `resume_baseline` so the meter
 *   stays continuous.
 * - **Mirror** — status is `running` and another tab is actively
 *   driving it (fresh heartbeat, owner_session_id matches a sibling
 *   tab). We don't compete — the persistence layer's heartbeat will
 *   keep refreshing the row, and our store stays in sync via
 *   periodic polling.
 *
 * Idempotency: the resume is gated by a `ran_once` ref so React 19
 * strict-mode's double-invoke doesn't kick off two simultaneous
 * `start()` calls.
 */

import * as React from "react";
import { toast } from "sonner";

import { readBatchState } from "@/db/library";
import type { PersistedActiveBatch } from "@/db/schema";
import { useAppStore } from "@/state/app";
import {
  HEARTBEAT_STALE_MS,
  SESSION_ID,
} from "@/state/batch_persist";

import { useRunBatch, type StartBatchInput } from "./useRunBatch";

/**
 * Pure decision helper exported for tests.
 *
 * Returns `true` when this tab should take ownership of the
 * persisted run; `false` when it should leave the run alone (either
 * because there's nothing to resume or because another tab is
 * actively driving it).
 *
 * Three claim-acceptable signals, any one of which suffices:
 *
 * - **`owned_by_us`** — the `owner_session_id` already matches our
 *   tab's `SESSION_ID`. This happens when the very same tab is
 *   resuming after a fast refresh that landed before our `pagehide`
 *   handler completed; treat the row as ours from the start.
 * - **`orphaned`** — `owner_session_id` is `null`. The previous
 *   owner cleared it on `pagehide`; we can claim immediately
 *   without waiting for the heartbeat to age out.
 * - **`stale`** — the heartbeat is older than
 *   {@link HEARTBEAT_STALE_MS}. Owner died hard (browser crash,
 *   force quit) before clearing ownership; reclaim after the
 *   grace period.
 */
export function shouldClaimOwnership(
  active: PersistedActiveBatch,
  opts: { now: number; our_session_id: string },
): boolean {
  if (active.status !== "running") return false;
  if (active.owner_session_id === opts.our_session_id) return true;
  if (active.owner_session_id === null) return true;
  if (opts.now - active.heartbeat_ms > HEARTBEAT_STALE_MS) return true;
  return false;
}

export function useResumeInterruptedBatch(): void {
  const { start } = useRunBatch();
  const ready = useAppStore((s) => s.ready);
  const ran_once = React.useRef(false);

  React.useEffect(() => {
    if (!ready) return;
    if (ran_once.current) return;
    ran_once.current = true;

    void (async () => {
      const persisted = await readBatchState();
      if (!persisted.active) return;
      if (persisted.active.status !== "running") return;

      // Skip when another tab in this same browser is the live
      // owner. The owner re-writes its session id every heartbeat,
      // so a fresh + matching session that isn't us means there's
      // a sibling tab driving the run.
      const should_resume = shouldClaimOwnership(persisted.active, {
        now: Date.now(),
        our_session_id: SESSION_ID,
      });
      if (!should_resume) return;

      // Re-derive the runner input from the persisted shape. Fields
      // not on the persisted row (e.g. provider config) come from
      // the live library DB the same way they did the first time.
      const input: StartBatchInput = {
        project_id: persisted.active.input.project_id,
        budget_usd: persisted.active.input.budget_usd,
        concurrency: persisted.active.input.concurrency,
        bypass_cache: persisted.active.input.bypass_cache,
        chapter_ids: persisted.active.input.chapter_ids,
        pre_pass: persisted.active.input.pre_pass,
      };

      // Surface the resume to the curator so it doesn't look like
      // the app is silently spending money. One-shot toast; the
      // BatchStatusBar takes care of progress visualisation from
      // here on.
      toast.message(
        `Resuming translation · ${persisted.active.project_name}`,
        {
          description: summariseProgress(persisted.active.summary),
        },
      );

      await start(input, {
        // The persisted hydrate already populated `useBatchStore.active`,
        // so a naive `start` would refuse to run because the store
        // sees a "live" batch. The runner's own busy check looks at
        // `active.finished` — our hydrated record is `finished:false`
        // exactly because it's mid-run. We therefore tell the runner
        // not to queue (the persisted state IS the run we're
        // resuming) and the runner will overwrite the store via its
        // own `start()` call.
        queue_if_busy: false,
        resume_baseline: {
          translated: persisted.active.summary.translated,
          cached: persisted.active.summary.cached,
          flagged: persisted.active.summary.flagged,
          failed: persisted.active.summary.failed,
          prompt_tokens: persisted.active.summary.prompt_tokens,
          completion_tokens: persisted.active.summary.completion_tokens,
          cost_usd: persisted.active.summary.cost_usd,
          elapsed_s: persisted.active.summary.elapsed_s,
          total: persisted.active.summary.total,
          paused_reason: persisted.active.summary.paused_reason,
          failures: persisted.active.summary.failures.map((f) => ({ ...f })),
        },
      });
    })();
  }, [ready, start]);
}

function summariseProgress(s: {
  translated: number;
  cached: number;
  flagged: number;
  failed: number;
  total: number;
}): string {
  const done = s.translated + s.cached + s.flagged + s.failed;
  if (s.total <= 0) return `${done} segments processed`;
  const pct = Math.round((done / s.total) * 100);
  return `${done}/${s.total} done (${pct}%) · picking up where the previous session left off`;
}
