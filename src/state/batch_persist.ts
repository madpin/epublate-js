/**
 * Mirrors `useBatchStore` into the library DB so a refresh restores
 * the BatchStatusBar identically and the auto-resume hook can pick
 * the run back up from the persisted input.
 *
 * The Zustand rule says stores "describe state, not effects". This
 * module is the effect side: it subscribes to the store and writes
 * to Dexie. It has no public state of its own — call
 * {@link installBatchStatePersistence} once at boot (after the
 * `useBatchStore` row has been hydrated from disk) and it manages
 * itself for the lifetime of the page.
 *
 * Cross-tab safety:
 *
 * - Each tab generates a unique `SESSION_ID` on first install.
 * - While `useBatchStore.active` is "running" in this tab, a
 *   heartbeat tick rewrites `owner_session_id` + `heartbeat_ms`
 *   every {@link HEARTBEAT_INTERVAL_MS}.
 * - On `pagehide` we fire a synchronous `releaseBatchOwnership()` so
 *   the next boot of *any* tab (most often the refreshing one) can
 *   take over immediately, without waiting for the heartbeat to
 *   expire.
 * - If a tab dies hard (browser crash), the heartbeat eventually
 *   goes stale and {@link useResumeInterruptedBatch} on the next
 *   boot decides to claim ownership.
 */

import {
  clearBatchState,
  releaseBatchOwnership,
  touchBatchHeartbeat,
  writeBatchState,
} from "@/db/library";
import type {
  PersistedActiveBatch,
  PersistedBatchInput,
  PersistedBatchSummary,
  PersistedQueuedBatch,
} from "@/db/schema";
import { newOpaqueId } from "@/lib/id";

import {
  useBatchStore,
  type ActiveBatch,
  type QueuedBatch,
} from "./batch";

/** Tab-local session id; stable for the lifetime of this page load. */
export const SESSION_ID = newOpaqueId();

/**
 * Heartbeat cadence. Tuned so a single missed beat is plenty of
 * margin for a slow IDB transaction without leaving stale ownership
 * around long enough to confuse the resume hook (which considers a
 * heartbeat older than {@link HEARTBEAT_STALE_MS} dead).
 */
export const HEARTBEAT_INTERVAL_MS = 2_000;

/**
 * Threshold the auto-resume hook uses to decide a heartbeat is stale.
 * Re-exported here so tests can pin the policy without depending on
 * the persistence module's internals.
 */
export const HEARTBEAT_STALE_MS = 6_000;

/** Minimum ms between persisted-state writes triggered by store
 *  updates. Coalesces the rapid `update()` stream a busy batch
 *  produces into ~2 IDB writes per second. Heartbeat ticks ride a
 *  separate timer so this throttle doesn't stretch them out.
 *
 *  Exported so tests can `await sleep(PERSIST_THROTTLE_MS + 50)` to
 *  observe the next flushed write without resorting to fake timers
 *  (which interact poorly with `fake-indexeddb`'s microtask scheduling).
 */
export const PERSIST_THROTTLE_MS = 100;

let installed = false;
let unsubscribe: (() => void) | null = null;
let heartbeat_handle: ReturnType<typeof setInterval> | null = null;
let throttle_timer: ReturnType<typeof setTimeout> | null = null;
let pending_write = false;
let pagehide_handler: (() => void) | null = null;

/**
 * Subscribe to the batch store and start mirroring its state to the
 * library DB. Idempotent — calling more than once is a no-op so the
 * App component can install on every mount without leaking listeners
 * (React 19 strict-mode double-invokes effects).
 */
export function installBatchStatePersistence(): void {
  if (installed) return;
  installed = true;

  // Persist on every store change (active or queue). The actual
  // write is throttled so a 200-segment burst doesn't fan out into
  // 200 IDB transactions — the heartbeat tick guarantees the row
  // stays fresh in the meantime.
  unsubscribe = useBatchStore.subscribe(() => {
    schedulePersist();
  });

  // Initial sync: hydrate may have already populated the store
  // before we installed; flush the current state so the persisted
  // row reflects it immediately. (Hydrating with `null/[]` is fine —
  // `writeBatchState` clears the row in that case.)
  schedulePersist();

  // Browsers fire `pagehide` for refresh, tab close, and
  // navigation-to-other-origin. Releasing ownership lets the very
  // next boot (most commonly the refreshing tab itself) claim the
  // run without the heartbeat-staleness wait.
  if (typeof window !== "undefined") {
    pagehide_handler = () => {
      void releaseBatchOwnership();
    };
    window.addEventListener("pagehide", pagehide_handler);
  }
}

/**
 * Tear down the subscription and timers. Used by tests to keep
 * cases isolated; the production app installs once for the page
 * lifetime and never uninstalls.
 */
export function uninstallBatchStatePersistence(): void {
  if (!installed) return;
  installed = false;
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (throttle_timer !== null) {
    clearTimeout(throttle_timer);
    throttle_timer = null;
  }
  pending_write = false;
  stopHeartbeat();
  if (pagehide_handler && typeof window !== "undefined") {
    window.removeEventListener("pagehide", pagehide_handler);
  }
  pagehide_handler = null;
}

function schedulePersist(): void {
  pending_write = true;
  if (throttle_timer !== null) return;
  throttle_timer = setTimeout(() => {
    throttle_timer = null;
    if (!pending_write) return;
    pending_write = false;
    void persistNow();
  }, PERSIST_THROTTLE_MS);
}

async function persistNow(): Promise<void> {
  const state = useBatchStore.getState();
  const active = state.active;
  const queue = state.queue;

  if (!active && queue.length === 0) {
    stopHeartbeat();
    await clearBatchState();
    return;
  }

  // Heartbeat lifecycle is keyed off `active && !finished`. Start /
  // stop the loop whenever the store crosses that boundary so a
  // dismissed run stops touching the DB.
  if (active && !active.finished) startHeartbeat();
  else stopHeartbeat();

  await writeBatchState({
    active: active ? toPersistedActive(active) : null,
    queue: queue.map(toPersistedQueued),
  });
}

function startHeartbeat(): void {
  if (heartbeat_handle !== null) return;
  // Fire the first tick immediately so a fresh resume registers
  // ownership without the curator-perceptible delay.
  void touchHeartbeat();
  heartbeat_handle = setInterval(() => {
    void touchHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeat_handle === null) return;
  clearInterval(heartbeat_handle);
  heartbeat_handle = null;
}

async function touchHeartbeat(): Promise<void> {
  const cur = useBatchStore.getState().active;
  if (!cur || cur.finished) {
    stopHeartbeat();
    return;
  }
  await touchBatchHeartbeat({
    owner_session_id: SESSION_ID,
    heartbeat_ms: Date.now(),
  });
}

// ---------- Conversions ----------

export function toPersistedActive(
  active: ActiveBatch,
): PersistedActiveBatch {
  return {
    project_id: active.project_id,
    project_name: active.project_name,
    started_at: active.started_at,
    input: active.input,
    summary: toPersistedSummary(active.summary),
    status: deriveStatus(active),
    paused_reason: active.paused_reason,
    // The heartbeat loop is the source of truth for these two
    // fields. We seed them on the first write so a refresh that
    // lands before the heartbeat tick still sees a non-zero
    // timestamp; the loop overwrites both within
    // `HEARTBEAT_INTERVAL_MS`.
    owner_session_id: active.finished ? null : SESSION_ID,
    heartbeat_ms: Date.now(),
  };
}

export function toPersistedQueued(item: QueuedBatch): PersistedQueuedBatch {
  return {
    id: item.id,
    project_id: item.project_id,
    project_name: item.project_name,
    enqueued_at: item.enqueued_at,
    label: item.label,
    input: toPersistedInput(item.input),
  };
}

function toPersistedInput(raw: unknown): PersistedBatchInput {
  // Queue items carry the runner's `StartBatchInput` shape verbatim.
  // The store treats it as opaque, so we re-derive a normalised
  // persistable shape here. Extra fields are dropped; missing fields
  // fall back to the same defaults `useRunBatch.start` would apply.
  const input = (raw ?? {}) as Partial<PersistedBatchInput> & {
    project_id?: string;
  };
  return {
    project_id: typeof input.project_id === "string" ? input.project_id : "",
    budget_usd:
      typeof input.budget_usd === "number" || input.budget_usd === null
        ? input.budget_usd
        : null,
    concurrency:
      typeof input.concurrency === "number" && input.concurrency > 0
        ? Math.trunc(input.concurrency)
        : 1,
    bypass_cache: input.bypass_cache === true,
    chapter_ids: Array.isArray(input.chapter_ids)
      ? input.chapter_ids.slice()
      : null,
    pre_pass: input.pre_pass === true,
  };
}

function toPersistedSummary(s: ActiveBatch["summary"]): PersistedBatchSummary {
  return {
    translated: s.translated,
    cached: s.cached,
    flagged: s.flagged,
    failed: s.failed,
    prompt_tokens: s.prompt_tokens,
    completion_tokens: s.completion_tokens,
    cost_usd: s.cost_usd,
    elapsed_s: s.elapsed_s,
    total: s.total,
    paused_reason: s.paused_reason,
    failures: s.failures.map((f) => ({ ...f })),
  };
}

function deriveStatus(active: ActiveBatch): PersistedActiveBatch["status"] {
  if (!active.finished) return "running";
  return active.final_status ?? "completed";
}

/**
 * Rebuild an `ActiveBatch` from a persisted row. Used by the
 * resume hook to seed `useBatchStore` before starting the runner.
 *
 * The reconstituted controller is a *fresh* AbortController — the
 * previous one died with the previous tab. The auto-resume code
 * passes this controller into the new `runBatch` call, so cancel
 * still works after a refresh.
 */
export function fromPersistedActive(
  row: PersistedActiveBatch,
): ActiveBatch {
  const finished = row.status !== "running";
  return {
    project_id: row.project_id,
    project_name: row.project_name,
    started_at: row.started_at,
    input: row.input,
    summary: {
      translated: row.summary.translated,
      cached: row.summary.cached,
      flagged: row.summary.flagged,
      failed: row.summary.failed,
      prompt_tokens: row.summary.prompt_tokens,
      completion_tokens: row.summary.completion_tokens,
      cost_usd: row.summary.cost_usd,
      elapsed_s: row.summary.elapsed_s,
      total: row.summary.total,
      paused_reason: row.summary.paused_reason,
      failures: row.summary.failures.map((f) => ({ ...f })),
    },
    controller: new AbortController(),
    finished,
    paused_reason: row.paused_reason,
    final_status: finished
      ? (row.status as "completed" | "cancelled" | "paused")
      : null,
  };
}

export function fromPersistedQueued(row: PersistedQueuedBatch): QueuedBatch {
  return {
    id: row.id,
    project_id: row.project_id,
    project_name: row.project_name,
    enqueued_at: row.enqueued_at,
    label: row.label,
    input: row.input,
  };
}
