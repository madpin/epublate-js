/**
 * `useRunIntake` — fire the helper-LLM book intake on a project.
 *
 * Mirrors `useRunBatch` in shape (resolve provider, surface toasts, run
 * the flow, rethrow nothing) but talks to `runBookIntake` instead of
 * the translator pool. The book intake is a one-shot pass — there's no
 * progress meter to drive, so we just toast on completion.
 */

import * as React from "react";
import { toast } from "sonner";

import {
  runBookIntake,
  DEFAULT_INTAKE_MAX_SEGMENTS,
  type IntakeSummary,
} from "@/core/extractor";
import { openProjectDb } from "@/db/dexie";
import { buildProvider, type ProjectLlmOverrides } from "@/llm/factory";
import { useAppStore } from "@/state/app";

export interface StartIntakeInput {
  project_id: string;
  bypass_cache?: boolean;
  max_segments?: number;
  chunk_max_tokens?: number;
  helper_model?: string | null;
}

export interface UseRunIntakeReturn {
  start(input: StartIntakeInput): Promise<IntakeSummary | null>;
  busy: boolean;
}

export function useRunIntake(): UseRunIntakeReturn {
  const [busy, setBusy] = React.useState(false);
  const mock_mode = useAppStore((s) => s.mock_mode);

  const start = React.useCallback(
    async (input: StartIntakeInput): Promise<IntakeSummary | null> => {
      if (busy) {
        toast.error("Intake is already running.");
        return null;
      }
      const detail_db = openProjectDb(input.project_id);
      const detail = await detail_db.projects.get(input.project_id);
      if (!detail) {
        toast.error("Project detail not found.");
        return null;
      }

      setBusy(true);
      try {
        const overrides = await readProjectOverrides(input.project_id);
        let provider;
        let helper_model: string;
        try {
          const built = await buildProvider({ mock: mock_mode, overrides });
          provider = built.provider;
          helper_model =
            input.helper_model?.trim() ||
            built.resolved?.helper_model ||
            built.resolved?.translator_model ||
            "mock-model";
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          toast.error(`Cannot start intake: ${msg}`);
          return null;
        }

        const summary = await runBookIntake({
          project_id: input.project_id,
          source_lang: detail.source_lang,
          target_lang: detail.target_lang,
          provider,
          options: {
            model: helper_model,
            max_segments: input.max_segments ?? DEFAULT_INTAKE_MAX_SEGMENTS,
            chunk_max_tokens: input.chunk_max_tokens,
            bypass_cache: input.bypass_cache ?? false,
            auto_propose: true,
          },
        });

        if (summary.failed_chunks > 0 && summary.proposed_count === 0) {
          toast.error(
            `Intake aborted · ${summary.failed_chunks} chunk(s) failed`,
          );
        } else if (summary.failed_chunks > 0) {
          toast.warning(
            `Intake finished with errors · ${summary.proposed_count} proposed · ${summary.failed_chunks} failed`,
          );
        } else {
          toast.success(
            `Intake finished · ${summary.proposed_count} entries proposed · $${summary.cost_usd.toFixed(4)}`,
          );
        }
        return summary;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Intake failed: ${msg}`);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [busy, mock_mode],
  );

  return { start, busy };
}

async function readProjectOverrides(
  projectId: string,
): Promise<ProjectLlmOverrides | null> {
  const db = openProjectDb(projectId);
  const row = await db.projects.get(projectId);
  if (!row?.llm_overrides) return null;
  try {
    return JSON.parse(row.llm_overrides) as ProjectLlmOverrides;
  } catch {
    return null;
  }
}
