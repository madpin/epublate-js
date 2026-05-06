/**
 * Reader → Prompt preview panel.
 *
 * Slide-in side panel anchored to a single segment. Re-runs the same
 * code paths as the live pipeline through {@link previewSegmentPrompt}
 * so the wire payload it shows is byte-equivalent to what would land
 * on the network.
 *
 * Powered by the shared {@link PromptPreview} component (also used by
 * {@link PromptSimulatorCard}). The Reader-specific part is:
 *
 *   - The segment is the curator's *focused* segment, not a
 *     simulator pivot. Switching segments rebuilds the preview.
 *   - The cache-status badge in the header is decisive: green means
 *     translating now reuses the cached trace.
 *   - Shift+P opens / closes the panel from the keyboard.
 *   - Per-panel "what-if" toggles match the simulator's. They never
 *     persist; closing or resetting drops them on the floor.
 */

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CircuitBoard, Eye, RefreshCw, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PromptPreview } from "@/components/settings/PromptPreview";
import {
  applyPromptOptionOverrides,
  resolvePromptOptions,
  type PromptOptions,
} from "@/core/prompt_options";
import {
  previewSegmentPrompt,
  type PreviewSegmentPromptResult,
} from "@/core/pipeline";
import type { Segment } from "@/formats/epub/types";
import { cn } from "@/lib/utils";
import type { EmbeddingProvider } from "@/llm/embeddings/base";

interface PromptPreviewPanelProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  project_id: string;
  source_lang: string;
  target_lang: string;
  /** The focused segment. */
  segment: Segment | null;
  /** Optional chapter title for the panel header. */
  chapter_title?: string | null;
  /**
   * Translator model slug (resolved per-project). Drives the cache
   * key + the cost meter so the badge matches what a live translate
   * would compute.
   */
  model: string;
  /** Persisted prompt options (legacy rows ⇒ DEFAULT_PROMPT_OPTIONS). */
  prompt_options: Partial<PromptOptions> | null | undefined;
  /**
   * Optional embedding provider. When present, the preview runs the
   * proposed-hint and `relevant`-context paths end-to-end. Reused
   * from the Reader's own provider builder so the preview matches
   * the live call exactly.
   */
  embedding_provider?: EmbeddingProvider | null;
}

const TOGGLE_LABELS: Record<keyof PromptOptions, string> = {
  include_language_notes: "Language notes",
  include_style_guide: "Style guide",
  include_book_summary: "Book summary",
  include_target_only: "Target-only",
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

export function PromptPreviewPanel({
  open,
  onOpenChange,
  project_id,
  source_lang,
  target_lang,
  segment,
  chapter_title,
  model,
  prompt_options,
  embedding_provider = null,
}: PromptPreviewPanelProps): React.JSX.Element {
  const persisted = React.useMemo(
    () => resolvePromptOptions(prompt_options),
    [prompt_options],
  );
  const [overrides, setOverrides] = React.useState<Partial<PromptOptions>>({});
  const effective = React.useMemo(
    () => applyPromptOptionOverrides(persisted, overrides),
    [persisted, overrides],
  );
  const dirty_overrides = Object.keys(overrides).length > 0;

  // Drop what-ifs whenever the panel closes or the segment changes —
  // the curator should always start from the project's defaults.
  React.useEffect(() => {
    if (!open) setOverrides({});
  }, [open]);
  React.useEffect(() => {
    setOverrides({});
  }, [segment?.id]);

  const [result, setResult] =
    React.useState<PreviewSegmentPromptResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reload_nonce, setReloadNonce] = React.useState(0);

  React.useEffect(() => {
    if (!open || !segment) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    const handle = window.setTimeout(() => {
      (async () => {
        try {
          const next = await previewSegmentPrompt({
            project_id,
            source_lang,
            target_lang,
            segment,
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
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [
    open,
    segment,
    project_id,
    source_lang,
    target_lang,
    model,
    effective,
    embedding_provider,
    reload_nonce,
  ]);

  const toggle = (key: keyof PromptOptions): void => {
    setOverrides((prev) => {
      const next = { ...prev };
      const persisted_value = persisted[key];
      const current_value = key in next ? next[key] : persisted_value;
      const flipped = !current_value;
      if (flipped === persisted_value) {
        delete next[key];
      } else {
        next[key] = flipped;
      }
      return next;
    });
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-background/40 backdrop-blur-[2px]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
          )}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col gap-3 border-l bg-background p-4 shadow-xl",
            "sm:max-w-2xl md:max-w-3xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
          )}
        >
          <header className="flex items-start justify-between gap-3">
            <div className="grid min-w-0 gap-0.5">
              <DialogPrimitive.Title className="flex items-center gap-2 text-base font-semibold">
                <CircuitBoard className="size-4 text-primary" />
                Prompt preview
                {dirty_overrides ? (
                  <Badge variant="warning" className="text-[10px]">
                    what-if active
                  </Badge>
                ) : null}
                <Badge variant="outline" className="text-[10px]">
                  Shift+P
                </Badge>
              </DialogPrimitive.Title>
              {segment ? (
                <p className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                  <Eye className="size-3" />
                  Segment{" "}
                  <code className="font-mono text-foreground">
                    {segment.id.slice(0, 7)}
                  </code>
                  {chapter_title ? (
                    <>
                      {" · "}
                      <span className="truncate font-medium text-foreground">
                        {chapter_title}
                      </span>
                    </>
                  ) : null}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  No segment focused.
                </p>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy || !segment}
                onClick={() => setReloadNonce((n) => n + 1)}
                className="h-7 gap-1 px-2 text-[11px]"
              >
                <RefreshCw
                  className={cn("size-3", busy ? "animate-spin" : null)}
                />
                Refresh
              </Button>
              <DialogPrimitive.Close
                className="rounded-sm p-1 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label="Close prompt preview"
              >
                <X className="size-4" />
              </DialogPrimitive.Close>
            </div>
          </header>

          <WhatIfBar
            persisted={persisted}
            overrides={overrides}
            onToggle={toggle}
            onReset={() => setOverrides({})}
            reset_disabled={!dirty_overrides}
          />

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              Could not build preview: {error}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-auto">
            <PromptPreview result={result} model={model} />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
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
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] transition-colors",
                value
                  ? "border-primary/60 bg-primary/15 text-foreground"
                  : "border-muted-foreground/40 bg-muted/40 text-muted-foreground line-through",
                overridden ? "ring-1 ring-warning/60" : "",
              )}
              aria-pressed={value}
            >
              {TOGGLE_LABELS[key]}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="grid gap-2 rounded-md border bg-muted/30 p-3">
      {renderGroup(SYSTEM_KEYS, "System prefix", "system")}
      {renderGroup(USER_KEYS, "User tail", "user")}
      <div className="flex items-center justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={reset_disabled}
          onClick={onReset}
          className="h-6 px-2 text-[11px]"
        >
          Reset what-ifs
        </Button>
      </div>
    </div>
  );
}
