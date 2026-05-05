/**
 * `useRunBatch` — single hook that owns the lifecycle of a batch run.
 *
 * Responsibilities:
 *   - Build (or rebuild) the LLM provider via `buildProvider`.
 *   - Reject a run if a batch is already in flight — *unless* the
 *     caller asked us to enqueue it, in which case we push the
 *     payload to the batch store and drain it on the next idle.
 *   - Push progress into `useBatchStore` so the persistent status bar
 *     and any open route can re-render off it.
 *   - Surface terminal states (completed / paused / cancelled) as
 *     toasts and finalize the store.
 */

import * as React from "react";
import { toast } from "sonner";

import { libraryDb } from "@/db/library";
import { openProjectDb } from "@/db/dexie";
import {
  BatchCancelled,
  BatchPaused,
  createSummary,
  runBatch,
  type BatchOptions,
} from "@/core/batch";
import { listGlossaryEntries } from "@/db/repo/glossary";
import { newId } from "@/lib/id";
import { buildProvider, type ProjectLlmOverrides } from "@/llm/factory";
import { useBatchStore, type QueuedBatch } from "@/state/batch";
import { useAppStore } from "@/state/app";
import { useTranslatingStore } from "@/state/translating";

export interface StartBatchInput {
  project_id: string;
  budget_usd?: number | null;
  concurrency?: number;
  bypass_cache?: boolean;
  chapter_ids?: readonly string[] | null;
  /** Run the helper-LLM pre-pass once per chapter before translating it. */
  pre_pass?: boolean;
}

export interface StartBatchOptions {
  /**
   * When `true` and a batch is already in flight, enqueue this request
   * instead of erroring out. The runner drains the queue automatically
   * once the active batch finishes.
   */
  queue_if_busy?: boolean;
  /** Curator-friendly label for the queued entry (e.g. "1 chapter"). */
  label?: string;
}

export function useRunBatch(): {
  start(input: StartBatchInput, options?: StartBatchOptions): Promise<void>;
  active: boolean;
  queue_size: number;
} {
  const start_store = useBatchStore((s) => s.start);
  const update_store = useBatchStore((s) => s.update);
  const finish_store = useBatchStore((s) => s.finish);
  const enqueue_store = useBatchStore((s) => s.enqueue);
  const dequeue_store = useBatchStore((s) => s.dequeue);
  const active = useBatchStore((s) => s.active);
  const queue_size = useBatchStore((s) => s.queue.length);
  const mock_mode = useAppStore((s) => s.mock_mode);
  const add_translating = useTranslatingStore((s) => s.add);
  const remove_translating = useTranslatingStore((s) => s.remove);
  const clear_translating = useTranslatingStore((s) => s.clearProject);

  // Stash the runtime callbacks in a ref so the queue-drain useEffect
  // doesn't trip the React-Hooks dep linter — and so a mid-batch
  // setting change (e.g. mock mode toggle) doesn't recreate the
  // start callback while a batch is in flight.
  const start_ref = React.useRef<
    (input: StartBatchInput, options?: StartBatchOptions) => Promise<void>
  >(async () => {
    /* placeholder, replaced before first call */
  });

  const start = React.useCallback(
    async (
      input: StartBatchInput,
      options: StartBatchOptions = {},
    ): Promise<void> => {
      // Snapshot the active batch from the store directly so the
      // queue check is consistent even when the previous render
      // already saw `finished: true` but the next batch hasn't
      // flushed through yet.
      const live = useBatchStore.getState().active;
      const busy = live !== null && !live.finished;

      if (busy) {
        if (options.queue_if_busy) {
          const lib_row = await libraryDb().projects.get(input.project_id);
          const project_name = lib_row?.name ?? "Project";
          const queued: QueuedBatch = {
            id: newId(),
            project_id: input.project_id,
            project_name,
            enqueued_at: Date.now(),
            label: options.label ?? describeInput(input),
            input,
          };
          enqueue_store(queued);
          toast.success(
            `Queued · ${queued.label}. Will start when the current batch finishes.`,
          );
          return;
        }
        toast.error("A batch is already in flight. Cancel it first.");
        return;
      }

      const lib_row = await libraryDb().projects.get(input.project_id);
      if (!lib_row) {
        toast.error("Project not found.");
        return;
      }
      const detail_db = openProjectDb(input.project_id);
      const detail = await detail_db.projects.get(input.project_id);
      if (!detail) {
        toast.error("Project detail not found.");
        return;
      }

      const overrides = await readProjectOverrides(input.project_id);
      let provider;
      let model: string;
      let helper_model: string;
      let reasoning_effort: BatchOptions["reasoning_effort"] | undefined;
      try {
        const built = await buildProvider({ mock: mock_mode, overrides });
        provider = built.provider;
        model = built.resolved?.translator_model ?? "mock-model";
        helper_model = built.resolved?.helper_model ?? model;
        reasoning_effort = built.resolved?.reasoning_effort ?? null;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Cannot start batch: ${msg}`);
        return;
      }

      const glossary_state = await listGlossaryEntries(input.project_id);

      const controller = new AbortController();
      const initial = createSummary();
      start_store({
        project_id: input.project_id,
        project_name: lib_row.name,
        summary: initial,
        controller,
      });

      try {
        const final = await runBatch({
          project_id: input.project_id,
          source_lang: detail.source_lang,
          target_lang: detail.target_lang,
          provider,
          options: {
            model,
            concurrency: input.concurrency ?? 1,
            budget_usd:
              input.budget_usd === undefined ? detail.budget_usd : input.budget_usd,
            bypass_cache: input.bypass_cache ?? false,
            chapter_ids: input.chapter_ids ?? null,
            reasoning_effort,
            pre_pass: input.pre_pass
              ? {
                  model: helper_model,
                  bypass_cache: input.bypass_cache ?? false,
                }
              : null,
          },
          glossary_state,
          on_progress: (ev) => {
            update_store(ev.summary);
          },
          on_segment_start: (ev) => {
            add_translating(input.project_id, ev.segment_id);
          },
          on_segment_end: (ev) => {
            remove_translating(input.project_id, ev.segment_id);
          },
          signal: controller.signal,
        });
        finish_store({ summary: final, final_status: "completed" });
        clear_translating(input.project_id);
        toast.success(
          `Batch finished · ${final.translated} translated · ${final.cached} cached · ${final.flagged} flagged · ${final.failed} failed · $${final.cost_usd.toFixed(4)}`,
        );
      } catch (err: unknown) {
        clear_translating(input.project_id);
        if (err instanceof BatchCancelled) {
          finish_store({
            summary: err.summary,
            final_status: "cancelled",
          });
          toast.message(
            `Batch cancelled · ${err.summary.translated} translated · ${err.summary.failed} failed`,
          );
        } else if (err instanceof BatchPaused) {
          finish_store({
            summary: err.summary,
            final_status: "paused",
            paused_reason: err.summary.paused_reason,
          });
          toast.warning(
            `Batch paused · ${err.summary.paused_reason ?? "budget cap reached"}`,
          );
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          finish_store({
            summary: initial,
            final_status: "paused",
            paused_reason: msg,
          });
          toast.error(`Batch failed: ${msg}`);
        }
      }

      // Drain the queue (FIFO). We pop one entry; the same effect
      // fires again when this next batch finishes, draining the
      // remainder one at a time. Sequential draining keeps the
      // concurrency contract simple.
      const next = dequeue_store();
      if (next) {
        const next_input = next.input as StartBatchInput;
        toast.message(`Starting queued batch · ${next.label}`);
        // Allow the React commit for the previous "finished" state
        // to flush before we kick off the next run; otherwise the
        // status bar can briefly show stale data.
        setTimeout(() => {
          void start_ref.current(next_input);
        }, 50);
      }
    },
    [
      mock_mode,
      enqueue_store,
      dequeue_store,
      start_store,
      update_store,
      finish_store,
      add_translating,
      remove_translating,
      clear_translating,
    ],
  );

  React.useEffect(() => {
    start_ref.current = start;
  }, [start]);

  return {
    start,
    active: active !== null && !active.finished,
    queue_size,
  };
}

function describeInput(input: StartBatchInput): string {
  const ids = input.chapter_ids;
  if (!ids || ids.length === 0) return "all pending segments";
  if (ids.length === 1) return "1 chapter";
  return `${ids.length} chapters`;
}

async function readProjectOverrides(
  projectId: string,
): Promise<ProjectLlmOverrides | null> {
  if (!projectId) return null;
  const db = openProjectDb(projectId);
  const row = await db.projects.get(projectId);
  if (!row?.llm_overrides) return null;
  try {
    return JSON.parse(row.llm_overrides) as ProjectLlmOverrides;
  } catch {
    return null;
  }
}
