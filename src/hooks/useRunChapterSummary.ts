/**
 * `useRunChapterSummary` — UI-side wrapper around
 * {@link runChapterSummary}. Same shape as {@link useRunBookSummary}
 * but operates on a single chapter or fans out across all chapters.
 *
 * Returns:
 *   - `start(projectId, options)` — kick off a chapter-summary run
 *     for one or all chapters. Resolves with the
 *     {@link ChapterSummaryResult} array.
 *   - `running` — whether any run is in flight.
 *   - `last_error` — last terminal error, if the run as a whole
 *     could not even start (e.g. provider could not be built).
 */

import * as React from "react";
import { toast } from "sonner";

import { openProjectDb } from "@/db/dexie";
import {
  runChapterSummary,
  type ChapterSummaryProgressEvent,
  type ChapterSummaryResult,
} from "@/core/summary";
import { buildProvider, type ProjectLlmOverrides } from "@/llm/factory";
import { useAppStore } from "@/state/app";

export interface UseRunChapterSummaryOptions {
  /** When set, only summarise this chapter id. */
  chapter_id?: string;
  /** When `chapter_id` is omitted, only generate for chapters with empty notes. */
  only_missing?: boolean;
  /** Skip the cache for this run. */
  bypass_cache?: boolean;
  on_progress?: (ev: ChapterSummaryProgressEvent) => void;
}

export function useRunChapterSummary(): {
  start(
    projectId: string,
    options?: UseRunChapterSummaryOptions,
  ): Promise<ChapterSummaryResult[] | null>;
  running: boolean;
  last_error: string | null;
} {
  const mock_mode = useAppStore((s) => s.mock_mode);
  const [running, setRunning] = React.useState(false);
  const [last_error, setLastError] = React.useState<string | null>(null);

  const start = React.useCallback(
    async (
      projectId: string,
      options: UseRunChapterSummaryOptions = {},
    ): Promise<ChapterSummaryResult[] | null> => {
      if (running) {
        toast.error("Already drafting chapter summaries. Wait for it to finish.");
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
          toast.error(`Cannot start chapter summary: ${msg}`);
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
      const label = options.chapter_id
        ? "chapter summary"
        : options.only_missing
          ? "missing chapter summaries"
          : "chapter summaries";
      const t0 = toast.loading(`Drafting ${label}…`);
      try {
        const results = await runChapterSummary({
          project_id: projectId,
          source_lang: detail.source_lang,
          target_lang: detail.target_lang,
          provider: built.provider,
          options: {
            model: helper_model,
            bypass_cache: options.bypass_cache,
          },
          chapter_id: options.chapter_id,
          only_missing: options.only_missing,
          on_progress: options.on_progress,
        });
        toast.dismiss(t0);
        const ok = results.filter((r) => r.summary).length;
        const fail = results.length - ok;
        const cost = results.reduce((acc, r) => acc + r.cost_usd, 0);
        if (results.length === 0) {
          toast.message(
            options.only_missing
              ? "No chapters were missing notes."
              : "No chapters to summarise.",
          );
        } else if (fail === 0) {
          toast.success(
            `Chapter summaries saved · ${ok} chapter${ok === 1 ? "" : "s"} · $${cost.toFixed(4)}`,
          );
        } else {
          toast.warning(
            `Chapter summaries: ${ok} ok · ${fail} failed · $${cost.toFixed(4)}`,
          );
        }
        return results;
      } catch (err: unknown) {
        toast.dismiss(t0);
        const msg = err instanceof Error ? err.message : String(err);
        setLastError(msg);
        toast.error(`Chapter summary failed: ${msg}`);
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
