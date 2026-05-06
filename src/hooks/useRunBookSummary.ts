/**
 * `useRunBookSummary` — UI-side wrapper around `runBookSummary`.
 *
 * Mirrors `useRunBatch`: it builds the configured LLM provider,
 * enforces single-flight (one summary at a time *per project*),
 * surfaces lifecycle as Sonner toasts, and lets the caller pass
 * an `on_chunk` listener for progress UI.
 *
 * The hook never runs unless the project's source/target language
 * pair is known — it pulls them from the project row alongside any
 * per-project `llm_overrides`. Returns:
 *
 *   - `start(projectId, options?)` — kick off a new book-summary
 *     run. Resolves with the {@link BookSummaryResult} or `null`
 *     when the run could not be started (already running / no
 *     provider).
 *   - `running` — whether a run is in flight.
 *   - `error` — last terminal error (toast already fired).
 */

import * as React from "react";
import { toast } from "sonner";

import { openProjectDb } from "@/db/dexie";
import {
  runBookSummary,
  type BookSummaryChunkEvent,
  type BookSummaryResult,
} from "@/core/summary";
import { buildProvider, type ProjectLlmOverrides } from "@/llm/factory";
import { useAppStore } from "@/state/app";

export interface UseRunBookSummaryOptions {
  /** Optional per-project bypass-cache toggle. */
  bypass_cache?: boolean;
  /** Optional callback per chunk attempt (success or failure). */
  on_chunk?: (ev: BookSummaryChunkEvent) => void;
}

export function useRunBookSummary(): {
  start(projectId: string, options?: UseRunBookSummaryOptions): Promise<BookSummaryResult | null>;
  running: boolean;
  last_error: string | null;
} {
  const mock_mode = useAppStore((s) => s.mock_mode);
  const [running, setRunning] = React.useState(false);
  const [last_error, setLastError] = React.useState<string | null>(null);

  const start = React.useCallback(
    async (
      projectId: string,
      options: UseRunBookSummaryOptions = {},
    ): Promise<BookSummaryResult | null> => {
      if (running) {
        toast.error("Already drafting a book summary. Wait for it to finish.");
        return null;
      }

      const db = openProjectDb(projectId);
      const detail = await db.projects.get(projectId);
      if (!detail) {
        toast.error("Project not found.");
        return null;
      }

      const overrides = await readProjectOverrides(projectId);
      const built = await buildProvider({ mock: mock_mode, overrides }).catch(
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          toast.error(`Cannot start book summary: ${msg}`);
          return null;
        },
      );
      if (!built) return null;
      const helper_model =
        built.resolved?.helper_model ??
        built.resolved?.translator_model ??
        "mock-model";

      setRunning(true);
      setLastError(null);
      const t0 = toast.loading("Drafting book summary…");
      try {
        const result = await runBookSummary({
          project_id: projectId,
          source_lang: detail.source_lang,
          target_lang: detail.target_lang,
          provider: built.provider,
          options: {
            model: helper_model,
            bypass_cache: options.bypass_cache,
          },
          on_chunk: options.on_chunk,
        });
        toast.dismiss(t0);
        if (result.summary) {
          toast.success(
            `Book summary saved · ${result.chunks} chunk${result.chunks === 1 ? "" : "s"} · $${result.cost_usd.toFixed(4)}`,
          );
        } else {
          setLastError(result.error ?? "no summary produced");
          toast.error(
            `Book summary failed${result.error ? ` · ${result.error}` : ""}`,
          );
        }
        return result;
      } catch (err: unknown) {
        toast.dismiss(t0);
        const msg = err instanceof Error ? err.message : String(err);
        setLastError(msg);
        toast.error(`Book summary failed: ${msg}`);
        return null;
      } finally {
        setRunning(false);
      }
    },
    [mock_mode, running],
  );

  return { start, running, last_error };
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
