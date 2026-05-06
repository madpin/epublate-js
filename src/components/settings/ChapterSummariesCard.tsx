/**
 * Project Settings → Chapter summaries card.
 *
 * One row per chapter with three responsibilities:
 *
 *   - **Show** the persisted `chapters.notes` (the per-chapter
 *     `<chapter_notes>` block in the user message).
 *   - **Edit** notes inline (textarea pops out under the row when
 *     the curator clicks the title — saves through
 *     {@link updateChapterNotes}).
 *   - **Generate / regenerate / clear** via {@link useRunChapterSummary}.
 *
 * Header carries two bulk actions:
 *
 *   - **Generate missing** — calls{" "}
 *     {@link useRunChapterSummary} with{" "}
 *     <code>only_missing: true</code>. Cheap; safe to spam.
 *   - **Regenerate all** — re-runs every chapter; warns curator
 *     before kicking off.
 *
 * All flows produce an{" "}
 * <code>intake_runs</code> row + a Sonner toast — same audit
 * surface as book intake / pre-pass.
 */

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ChevronDown,
  ChevronRight,
  Eraser,
  ListChecks,
  Save,
  Sparkles,
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
import { Textarea } from "@/components/ui/textarea";
import { listChapters, updateChapterNotes } from "@/db/repo/chapters";
import { ChapterStatus, type ChapterRow } from "@/db/schema";
import { useRunChapterSummary } from "@/hooks/useRunChapterSummary";
import { countTokensSync } from "@/llm/tokens";

interface ChapterSummariesCardProps {
  project_id: string;
  /**
   * Whether `include_chapter_notes` is enabled in the project's
   * `prompt_options`. Used only to colour the per-row "block off"
   * hint — the notes are still persisted regardless.
   */
  block_enabled: boolean;
}

export function ChapterSummariesCard({
  project_id,
  block_enabled,
}: ChapterSummariesCardProps): React.JSX.Element {
  const chapters =
    useLiveQuery(async () => listChapters(project_id), [project_id]) ?? [];
  const { start: runChapterSummary, running } = useRunChapterSummary();
  const [confirm_all, setConfirmAll] = React.useState(false);

  const total = chapters.length;
  const present = chapters.filter((c) => c.notes && c.notes.trim()).length;
  const missing = total - present;

  const handleBulkMissing = async (): Promise<void> => {
    if (missing === 0) {
      toast.message("Every chapter already has notes.");
      return;
    }
    await runChapterSummary(project_id, { only_missing: true });
  };

  const handleBulkAll = async (): Promise<void> => {
    setConfirmAll(false);
    await runChapterSummary(project_id, {});
  };

  return (
    <Card id="chapter-summaries">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecks className="size-4 text-primary" />
          Chapter summaries
          {block_enabled ? null : (
            <Badge variant="outline" className="text-[10px]">
              prompt block off
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          50–120 word recap per chapter. Lives in the user message
          (per-segment tail) so it doesn't break the system-prefix
          cache. Use the bulk action to fill missing notes from the
          chapter's source segments; edit inline to refine.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="text-[10px]">
              {total} chapter{total === 1 ? "" : "s"}
            </Badge>
            <Badge
              variant={present === total && total > 0 ? "success" : "outline"}
              className="text-[10px]"
            >
              {present} with notes
            </Badge>
            <Badge
              variant={missing > 0 ? "warning" : "outline"}
              className="text-[10px]"
            >
              {missing} missing
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={running || total === 0}
              onClick={() => setConfirmAll(true)}
            >
              Regenerate all
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={running || missing === 0}
              onClick={() => void handleBulkMissing()}
              className="gap-1.5"
            >
              <Sparkles className="size-3.5" />
              {running
                ? "Generating…"
                : `Generate missing${missing > 0 ? ` (${missing})` : ""}`}
            </Button>
          </div>
        </div>

        {total === 0 ? (
          <p className="rounded-md border border-dashed border-muted-foreground/30 px-3 py-6 text-center text-xs text-muted-foreground">
            No chapters yet — finish the ePub intake before drafting
            chapter summaries.
          </p>
        ) : (
          <div className="grid gap-2">
            {chapters.map((c) => (
              <ChapterRowEditor
                key={c.id}
                project_id={project_id}
                chapter={c}
                disabled={running}
                runOne={(opts) => runChapterSummary(project_id, opts)}
              />
            ))}
          </div>
        )}

        {confirm_all ? (
          <ConfirmAllPanel
            count={total}
            onCancel={() => setConfirmAll(false)}
            onConfirm={() => void handleBulkAll()}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

interface ChapterRowEditorProps {
  project_id: string;
  chapter: ChapterRow;
  disabled: boolean;
  runOne(opts: { chapter_id: string }): Promise<unknown>;
}

function ChapterRowEditor({
  project_id,
  chapter,
  disabled,
  runOne,
}: ChapterRowEditorProps): React.JSX.Element {
  const persisted = chapter.notes ?? "";
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(persisted);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setDraft(persisted);
  }, [persisted]);

  const dirty = draft !== persisted;
  const tokens = draft.trim() ? countTokensSync(draft) : 0;

  const onSave = async (): Promise<void> => {
    setBusy(true);
    try {
      await updateChapterNotes(project_id, chapter.id, draft || null);
      toast.success(
        draft.trim() ? "Chapter notes saved." : "Chapter notes cleared.",
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not save: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const onClear = async (): Promise<void> => {
    setDraft("");
    setBusy(true);
    try {
      await updateChapterNotes(project_id, chapter.id, null);
      toast.success("Chapter notes cleared.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not clear: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const onGenerate = async (): Promise<void> => {
    await runOne({ chapter_id: chapter.id });
  };

  const has_notes = persisted.trim().length > 0;
  const preview = persisted.trim().split(/\s+/).slice(0, 18).join(" ");

  return (
    <div className="rounded-md border bg-card/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-accent/50"
        aria-expanded={open}
      >
        <span className="mt-0.5 text-muted-foreground">
          {open ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {String(chapter.spine_idx + 1).padStart(2, "0")}
            </span>
            <span className="truncate text-sm font-medium">
              {chapter.title?.trim() || chapter.href}
            </span>
            <ChapterStatusBadge status={chapter.status} />
            {has_notes ? (
              <Badge variant="success" className="text-[10px]">
                notes
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">
                no notes
              </Badge>
            )}
          </span>
          {has_notes ? (
            <span className="line-clamp-1 text-[11px] text-muted-foreground">
              {preview}
              {persisted.length > preview.length ? "…" : ""}
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className="grid gap-2 border-t px-3 py-3">
          <Textarea
            id={`cs-${chapter.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            disabled={busy || disabled}
            placeholder="Empty — generate from this chapter's segments or paste your own."
            className="font-mono text-[12px]"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>
              <code className="font-mono">{tokens.toLocaleString()}</code>{" "}
              tokens
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || disabled || !persisted.trim()}
                onClick={() => void onClear()}
                className="gap-1.5"
              >
                <Eraser className="size-3.5" />
                Clear
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy || disabled}
                onClick={() => void onGenerate()}
                className="gap-1.5"
              >
                <Sparkles className="size-3.5" />
                {has_notes ? "Regenerate" : "Generate"}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy || disabled || !dirty}
                onClick={() => void onSave()}
                className="gap-1.5"
              >
                <Save className="size-3.5" />
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChapterStatusBadge({
  status,
}: {
  status: ChapterRow["status"];
}): React.JSX.Element {
  if (status === ChapterStatus.DONE) {
    return (
      <Badge variant="success" className="text-[10px]">
        done
      </Badge>
    );
  }
  if (status === ChapterStatus.IN_PROGRESS) {
    return (
      <Badge variant="warning" className="text-[10px]">
        in progress
      </Badge>
    );
  }
  if (status === ChapterStatus.LOCKED) {
    return (
      <Badge variant="locked" className="text-[10px]">
        locked
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px]">
      pending
    </Badge>
  );
}

function ConfirmAllPanel({
  count,
  onCancel,
  onConfirm,
}: {
  count: number;
  onCancel(): void;
  onConfirm(): void;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
      <div className="font-medium">
        Regenerate all {count} chapter summary blocks?
      </div>
      <p className="mt-1 text-muted-foreground">
        Existing notes are overwritten. Each chapter runs through the
        helper-LLM and writes one{" "}
        <code className="font-mono">intake_runs</code> row. Cache hits
        cost <code className="font-mono">$0.00</code>; misses bill at
        the helper model's rate.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={onConfirm}>
          Regenerate all
        </Button>
      </div>
    </div>
  );
}
