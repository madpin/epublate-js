/**
 * Batch progress store (per-project, with a follow-up queue).
 *
 * The Reader, the Inbox, and the persistent `BatchStatusBar` all read
 * from this store. The runner mutates `active` as work completes; the
 * status bar's "Cancel" button writes through the same store to flip
 * the AbortController.
 *
 * Queueing: only one batch runs at a time, but curators can pile up
 * follow-up jobs (e.g. queue chapter B while chapter A is still mid-
 * batch). `useRunBatch` consults the store, enqueues if a run is
 * already in flight, and on completion drains the queue automatically.
 *
 * Persistence: a sibling `state/batch_persist.ts` subscribes to this
 * store and mirrors `active` + `queue` into the library DB so a
 * page refresh restores the BatchStatusBar identically and lets the
 * runner auto-resume from the persisted input. The store stays
 * synchronous and side-effect-free; the persistence layer is opt-in
 * (installed once at app boot in `App.tsx`).
 */

import { create } from "zustand";

import type { BatchSummary } from "@/core/batch";
import type { PersistedBatchInput } from "@/db/schema";

export interface ActiveBatch {
  project_id: string;
  project_name: string;
  started_at: number;
  /** Curator-submitted input, replayed verbatim by the auto-resume
   *  hook after a refresh. Stored on the `active` row (not just on
   *  the queue items) so a single-tab refresh during the very first
   *  segment of a fresh batch can still pick it back up. */
  input: PersistedBatchInput;
  /** Snapshot of the running summary; mutated as workers complete. */
  summary: BatchSummary;
  /** Curator presses Cancel ⇒ we abort. Set by the runner caller.
   *  Process-only; not persisted (a fresh AbortController is
   *  reconstructed when the auto-resume hook calls `start` again). */
  controller: AbortController;
  /** True after `runBatch` returns / throws — used to keep the bar on
   * screen long enough for the user to see the final tally. */
  finished: boolean;
  /** Surfaced reason if the run paused (budget cap, rate limit). */
  paused_reason: string | null;
  /** Curator-facing label for the most recent finalized state. */
  final_status: "completed" | "cancelled" | "paused" | null;
}

/** Snapshot of an enqueued (but not yet executing) batch request. The
 *  shape mirrors `StartBatchInput` from `useRunBatch`, kept opaque so
 *  the store doesn't have to know the runner's typing. */
export interface QueuedBatch {
  /** Stable id, generated when the curator enqueues. */
  id: string;
  project_id: string;
  project_name: string;
  enqueued_at: number;
  /** Curator-friendly summary of what's queued (e.g. "12 chapters").
   *  Used by the status bar so the curator can see what's coming up
   *  without re-opening the modal. */
  label: string;
  /** Runner-supplied payload, opaque to the store. */
  input: unknown;
}

interface BatchStore {
  active: ActiveBatch | null;
  queue: QueuedBatch[];
  start(opts: {
    project_id: string;
    project_name: string;
    input: PersistedBatchInput;
    summary: BatchSummary;
    controller: AbortController;
  }): void;
  update(summary: BatchSummary): void;
  finish(opts: {
    summary: BatchSummary;
    final_status: "completed" | "cancelled" | "paused";
    paused_reason?: string | null;
  }): void;
  dismiss(): void;
  cancel(): void;
  enqueue(item: QueuedBatch): void;
  /** Dequeue and return the next pending request (FIFO). Caller is
   *  responsible for actually starting the run with the returned
   *  payload — keeping the store free of side-effects. */
  dequeue(): QueuedBatch | null;
  removeQueued(id: string): void;
  clearQueue(): void;
  /**
   * Replace `active` and `queue` wholesale. Used by the bootstrap
   * path in `App.tsx` to repaint the BatchStatusBar from the
   * persisted library DB row before the curator sees first paint.
   *
   * Distinct from `start` because it doesn't allocate a new
   * `started_at`/AbortController — it carries over whatever the
   * caller assembled from the persisted snapshot.
   */
  hydrate(opts: {
    active: ActiveBatch | null;
    queue: QueuedBatch[];
  }): void;
}

export const useBatchStore = create<BatchStore>()((set, get) => ({
  active: null,
  queue: [],

  start({ project_id, project_name, input, summary, controller }) {
    set({
      active: {
        project_id,
        project_name,
        started_at: Date.now(),
        input,
        summary,
        controller,
        finished: false,
        paused_reason: null,
        final_status: null,
      },
    });
  },

  update(summary) {
    const cur = get().active;
    if (!cur) return;
    set({
      active: {
        ...cur,
        summary,
      },
    });
  },

  finish({ summary, final_status, paused_reason }) {
    const cur = get().active;
    if (!cur) return;
    set({
      active: {
        ...cur,
        summary,
        finished: true,
        final_status,
        paused_reason: paused_reason ?? null,
      },
    });
  },

  dismiss() {
    set({ active: null });
  },

  cancel() {
    const cur = get().active;
    if (!cur || cur.finished) return;
    cur.controller.abort();
  },

  enqueue(item) {
    set((state) => ({ queue: [...state.queue, item] }));
  },

  dequeue() {
    const { queue } = get();
    if (queue.length === 0) return null;
    const [head, ...rest] = queue;
    set({ queue: rest });
    return head;
  },

  removeQueued(id) {
    set((state) => ({ queue: state.queue.filter((q) => q.id !== id) }));
  },

  clearQueue() {
    set({ queue: [] });
  },

  hydrate({ active, queue }) {
    set({ active, queue });
  },
}));
