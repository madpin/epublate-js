/**
 * Project Settings → Prompt simulator card.
 *
 * Renders the **exact** translator prompt that{" "}
 * {@link translateSegment} would post for a representative segment
 * of the project, complete with token + cost meters and a what-if
 * toggle bar that overrides the persisted{" "}
 * {@link PromptOptions} for preview only.
 *
 * Why this exists:
 *
 *   - Curators previously had no way to inspect what the LLM was
 *     actually asked to do. Disabling a block in{" "}
 *     {@link PromptOptionsCard} was an act of faith.
 *   - With the system / user split (Phase 1) the system message is a
 *     cacheable prefix shared across every segment in a chapter; the
 *     simulator surfaces the prefix-vs-tail ratio so curators can see
 *     the cache benefit at a glance.
 *   - The wire-payload tab in{" "}
 *     {@link PromptPreview} is byte-equivalent to what would land on
 *     the network — that's the contract the Phase 7 smoke test
 *     ratifies against the real Ollama endpoint.
 *
 * Sources:
 *
 *   - The first non-empty segment in spine order is the preview
 *     pivot. We re-pick whenever the project's chapters change so
 *     the curator never sees a "no preview" gap right after intake.
 *   - The model slug is the resolved LLM config slug (per-project
 *     overrides win) — that way the cache key in the preview is the
 *     same one the live call would compute.
 *   - When embeddings are configured, we build a real provider so the
 *     proposed-hint and `relevant`-context paths run end-to-end. No
 *     embedding rows are written.
 */

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  CircuitBoard,
  Eye,
  RefreshCw,
  ScrollText,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  PromptPreview,
} from "@/components/settings/PromptPreview";
import {
  applyPromptOptionOverrides,
  resolvePromptOptions,
  type PromptOptions,
} from "@/core/prompt_options";
import {
  previewSegmentPrompt,
  type PreviewSegmentPromptResult,
} from "@/core/pipeline";
import { openProjectDb } from "@/db/dexie";
import { listChapters } from "@/db/repo/chapters";
import { listSegmentsForChapter } from "@/db/repo/segments";
import { isTriviallyEmpty } from "@/formats/epub/segmentation";
import type { Segment } from "@/formats/epub/types";
import { readLlmConfig } from "@/db/library";
import { resolveLlmConfig, type ProjectLlmOverrides } from "@/llm/factory";
import {
  buildEmbeddingProvider,
  type ProjectEmbeddingOverrides,
} from "@/llm/embeddings/factory";
import { useAppStore } from "@/state/app";

interface PromptSimulatorCardProps {
  project_id: string;
  /** Persisted {@link PromptOptions} (or null for legacy rows). */
  prompt_options: Partial<PromptOptions> | null | undefined;
  /**
   * Bumped by the parent every time the persisted prompt options
   * change — forces a fresh preview without making the parent feed
   * the override map.
   */
  refresh_token?: number;
}

const TOGGLE_LABELS: Record<keyof PromptOptions, string> = {
  include_language_notes: "Language notes",
  include_style_guide: "Style guide",
  include_book_summary: "Book summary",
  include_target_only: "Target-only terms",
  include_chapter_notes: "Chapter notes",
  include_proposed_hints: "Proposed hints",
  include_recent_context: "Recent context",
};

const SYSTEM_KEYS: ReadonlyArray<keyof PromptOptions> = [
  "include_language_notes",
  "include_style_guide",
  "include_book_summary",
  "include_target_only",
];
const USER_KEYS: ReadonlyArray<keyof PromptOptions> = [
  "include_chapter_notes",
  "include_proposed_hints",
  "include_recent_context",
];

export function PromptSimulatorCard({
  project_id,
  prompt_options,
  refresh_token = 0,
}: PromptSimulatorCardProps): React.JSX.Element {
  const mock_mode = useAppStore((s) => s.mock_mode);
  const persisted = React.useMemo(
    () => resolvePromptOptions(prompt_options),
    [prompt_options],
  );
  const [overrides, setOverrides] = React.useState<Partial<PromptOptions>>({});
  const effective = React.useMemo(
    () => applyPromptOptionOverrides(persisted, overrides),
    [persisted, overrides],
  );

  // Re-pick the preview pivot when chapters change. The simulator
  // walks the spine in order and grabs the first non-trivial segment
  // — same heuristic as the smoke test in `tools/snap.mjs`.
  const chapters =
    useLiveQuery(async () => listChapters(project_id), [project_id]) ?? [];
  const [pivot, setPivot] = React.useState<Segment | null>(null);
  const [pivot_chapter_title, setPivotChapterTitle] = React.useState<string>("");

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const ch of chapters) {
        const segs = await listSegmentsForChapter(project_id, ch.id);
        const candidate = segs.find((s) => !isTriviallyEmpty(s.source_text));
        if (candidate) {
          if (!cancelled) {
            setPivot(candidate);
            setPivotChapterTitle(ch.title?.trim() || ch.href);
          }
          return;
        }
      }
      if (!cancelled) {
        setPivot(null);
        setPivotChapterTitle("");
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [chapters, project_id]);

  // Resolve the model slug + project source/target lang once per
  // render of the dependent inputs. We need both to call
  // `previewSegmentPrompt`.
  const [model, setModel] = React.useState<string>("(unset)");
  const [langs, setLangs] = React.useState<{ src: string; tgt: string }>({
    src: "",
    tgt: "",
  });
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = openProjectDb(project_id);
      const proj = await db.projects.get(project_id);
      if (!proj || cancelled) return;
      setLangs({ src: proj.source_lang, tgt: proj.target_lang });
      try {
        const lib = await readLlmConfig();
        const overrides_blob: ProjectLlmOverrides | null = proj.llm_overrides
          ? (JSON.parse(proj.llm_overrides) as ProjectLlmOverrides)
          : null;
        const resolved = resolveLlmConfig(lib, overrides_blob);
        if (!cancelled) setModel(resolved.translator_model);
      } catch {
        // Library not configured yet — keep the placeholder slug so
        // the cost meter renders zero rather than throwing.
        if (!cancelled) setModel(mock_mode ? "mock-model" : "(unset)");
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project_id, mock_mode, refresh_token]);

  // Build the preview result. Re-runs whenever the pivot, the
  // effective options, or the parent's refresh token changes. We
  // debounce a touch so flipping a toggle doesn't thrash Dexie.
  const [result, setResult] =
    React.useState<PreviewSegmentPromptResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reload_nonce, setReloadNonce] = React.useState(0);

  React.useEffect(() => {
    if (!pivot || !langs.src || !langs.tgt) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    const handle = window.setTimeout(() => {
      (async () => {
        let embedding_provider = null;
        try {
          const db = openProjectDb(project_id);
          const proj = await db.projects.get(project_id);
          const overrides_blob: ProjectLlmOverrides | null = proj?.llm_overrides
            ? (JSON.parse(proj.llm_overrides) as ProjectLlmOverrides)
            : null;
          const emb_overrides: ProjectEmbeddingOverrides | null =
            overrides_blob?.embedding ?? null;
          const built = await buildEmbeddingProvider({
            mock: mock_mode,
            overrides: emb_overrides,
          }).catch(() => ({ provider: null, resolved: null }));
          embedding_provider = built.provider;
        } catch {
          embedding_provider = null;
        }
        try {
          const next = await previewSegmentPrompt({
            project_id,
            source_lang: langs.src,
            target_lang: langs.tgt,
            segment: pivot,
            model,
            prompt_options: effective,
            embedding_provider,
          });
          if (!cancelled) setResult(next);
        } catch (err: unknown) {
          if (!cancelled) {
            const msg = err instanceof Error ? err.message : String(err);
            setError(msg);
            setResult(null);
          }
        } finally {
          if (!cancelled) setBusy(false);
        }
      })().catch(() => {});
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [
    pivot,
    langs.src,
    langs.tgt,
    model,
    effective,
    project_id,
    mock_mode,
    refresh_token,
    reload_nonce,
  ]);

  const dirty_overrides = React.useMemo(() => {
    return Object.keys(overrides).length > 0;
  }, [overrides]);

  const toggle = (key: keyof PromptOptions): void => {
    setOverrides((prev) => {
      const next = { ...prev };
      const persisted_value = persisted[key];
      const current_value = key in next ? next[key] : persisted_value;
      const flipped = !current_value;
      // If the toggle now matches the persisted state, drop the
      // override entirely so `dirty_overrides` flips back to false.
      if (flipped === persisted_value) {
        delete next[key];
      } else {
        next[key] = flipped;
      }
      return next;
    });
  };

  const reset = (): void => {
    if (!dirty_overrides) {
      toast.message("No what-if overrides to reset.");
      return;
    }
    setOverrides({});
  };

  return (
    <Card id="prompt-simulator">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CircuitBoard className="size-4 text-primary" />
          Prompt simulator
          {dirty_overrides ? (
            <Badge variant="warning" className="text-[10px]">
              what-if active
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          A live, byte-for-byte preview of what the translator
          prompt looks like for a representative segment of this
          project. Toggle the what-if knobs below to see how
          enabling / disabling each block changes the prompt size,
          cost, and the system-prefix cache ratio. <strong>
            Nothing is saved or sent.
          </strong>{" "}
          Save your real settings in the{" "}
          <em>Prompt options</em> card above.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!pivot ? (
          <div className="rounded-md border border-dashed border-muted-foreground/30 px-3 py-6 text-center text-xs text-muted-foreground">
            <ScrollText className="mx-auto mb-1.5 size-5 opacity-50" />
            <span>
              No translatable segment found yet — finish the ePub
              intake to populate the simulator.
            </span>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Eye className="size-3.5" />
                Previewing segment{" "}
                <code className="font-mono text-foreground">
                  {pivot.id.slice(0, 7)}
                </code>{" "}
                in{" "}
                <span className="truncate font-medium text-foreground">
                  {pivot_chapter_title}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setReloadNonce((n) => n + 1)}
                className="h-6 gap-1 px-2 text-[11px]"
              >
                <RefreshCw className={`size-3 ${busy ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>

            <WhatIfBar
              persisted={persisted}
              overrides={overrides}
              onToggle={toggle}
              onReset={reset}
              reset_disabled={!dirty_overrides}
            />

            {error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                Could not build preview: {error}
              </div>
            ) : null}

            <PromptPreview result={result} model={model} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function WhatIfBar({
  persisted,
  overrides,
  onToggle,
  onReset,
  reset_disabled,
}: {
  persisted: PromptOptions;
  overrides: Partial<PromptOptions>;
  onToggle(key: keyof PromptOptions): void;
  onReset(): void;
  reset_disabled: boolean;
}): React.JSX.Element {
  const renderGroup = (
    keys: ReadonlyArray<keyof PromptOptions>,
    title: string,
    badge: string,
  ): React.JSX.Element => (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>{title}</span>
        <Badge variant="outline" className="text-[10px]">
          {badge}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {keys.map((key) => {
          const persisted_value = persisted[key];
          const overridden = key in overrides;
          const value = overridden ? overrides[key]! : persisted_value;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onToggle(key)}
              className={[
                "rounded-md border px-2 py-1 text-[11px] transition-colors",
                value
                  ? "border-primary/60 bg-primary/15 text-foreground"
                  : "border-muted-foreground/40 bg-muted/40 text-muted-foreground line-through",
                overridden ? "ring-1 ring-warning/60" : "",
              ].join(" ")}
              aria-pressed={value}
              title={`${TOGGLE_LABELS[key]} — ${value ? "on" : "off"}${overridden ? " (what-if)" : ""}`}
            >
              {TOGGLE_LABELS[key]}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="grid gap-3 rounded-md border bg-muted/30 p-3">
      {renderGroup(SYSTEM_KEYS, "System prefix (cacheable)", "system")}
      {renderGroup(USER_KEYS, "User tail (per-segment)", "user")}
      <div className="flex items-center justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={reset_disabled}
          onClick={onReset}
          className="h-7 px-2 text-[11px]"
        >
          Reset what-ifs
        </Button>
      </div>
    </div>
  );
}
