/**
 * Batch translate modal — kicks off a background batch run.
 *
 * Pre-populates concurrency and budget from the project row, lets the
 * curator override them, and pushes the run through `useRunBatch`.
 * Mirrors `epublate.app.modals.BatchModal`.
 */

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { openProjectDb } from "@/db/dexie";
import { countPendingByChapter } from "@/db/repo/segments";
import { useFormShortcuts } from "@/hooks/useFormShortcuts";
import { useRunBatch } from "@/hooks/useRunBatch";
import { useAppStore } from "@/state/app";
import { cn } from "@/lib/utils";

interface BatchModalProps {
  project_id: string;
  /** Restrict the run to specific chapters (e.g. from the dashboard). */
  chapter_ids?: readonly string[] | null;
  default_budget_usd?: number | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  pending_count?: number;
}

export function BatchModal({
  project_id,
  chapter_ids,
  default_budget_usd,
  open,
  onOpenChange,
  pending_count,
}: BatchModalProps): React.JSX.Element {
  const default_concurrency = useAppStore(
    (s) => s.ui.default_concurrency ?? 4,
  );
  const default_budget_pref = useAppStore((s) => s.ui.default_budget_usd);
  const initial_budget =
    default_budget_usd ?? default_budget_pref ?? null;

  const [concurrency, setConcurrency] = React.useState(
    String(default_concurrency),
  );
  const [budget, setBudget] = React.useState(
    initial_budget != null ? String(initial_budget) : "",
  );
  const [bypass_cache, setBypassCache] = React.useState(false);
  const [pre_pass, setPrePass] = React.useState(false);
  const { start, active, queue_size } = useRunBatch();
  const formRef = React.useRef<HTMLFormElement | null>(null);
  useFormShortcuts(formRef, open);

  // Live chapter list + pending counts. We pull both inside the modal
  // so the picker shows fresh numbers every time it opens — chapters
  // can be retranslated, so a stale count would mislead the curator.
  const chapters_with_counts = useLiveQuery(
    async () => {
      if (!open || !project_id) return null;
      const db = openProjectDb(project_id);
      const rows = await db.chapters
        .where("project_id")
        .equals(project_id)
        .sortBy("spine_idx");
      const counts = await countPendingByChapter(project_id);
      return rows.map((row) => ({
        id: row.id,
        spine_idx: row.spine_idx,
        title: row.title,
        href: row.href,
        pending: counts.get(row.id) ?? 0,
      }));
    },
    [open, project_id],
    null,
  );

  // Restricted chapter ids passed in by the caller (e.g. the Reader's
  // "Translate chapter" button). Used to seed the initial selection.
  const restricted_set = React.useMemo<ReadonlySet<string> | null>(() => {
    if (!chapter_ids || chapter_ids.length === 0) return null;
    return new Set(chapter_ids);
  }, [chapter_ids]);

  const [selection, setSelection] = React.useState<Set<string>>(
    () => new Set(),
  );

  // Re-seed selection whenever the modal opens or the live chapter
  // list/restriction changes underneath us.
  React.useEffect(() => {
    if (!open) return;
    if (!chapters_with_counts) return;
    const next = new Set<string>();
    if (restricted_set) {
      for (const id of restricted_set) next.add(id);
    } else {
      for (const ch of chapters_with_counts) {
        if (ch.pending > 0) next.add(ch.id);
      }
    }
    setSelection(next);
  }, [open, chapters_with_counts, restricted_set]);

  React.useEffect(() => {
    if (open) {
      setConcurrency(String(default_concurrency));
      setBudget(initial_budget != null ? String(initial_budget) : "");
      setBypassCache(false);
      setPrePass(false);
    }
  }, [open, default_concurrency, initial_budget]);

  const toggle_chapter = React.useCallback((id: string): void => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const select_all = React.useCallback((): void => {
    if (!chapters_with_counts) return;
    setSelection(new Set(chapters_with_counts.map((c) => c.id)));
  }, [chapters_with_counts]);

  const select_pending = React.useCallback((): void => {
    if (!chapters_with_counts) return;
    setSelection(
      new Set(
        chapters_with_counts.filter((c) => c.pending > 0).map((c) => c.id),
      ),
    );
  }, [chapters_with_counts]);

  const select_none = React.useCallback((): void => {
    setSelection(new Set());
  }, []);

  const selected_pending_total = React.useMemo<number>(() => {
    if (!chapters_with_counts) return 0;
    let n = 0;
    for (const ch of chapters_with_counts) {
      if (selection.has(ch.id)) n += ch.pending;
    }
    return n;
  }, [chapters_with_counts, selection]);

  const onStart = async (): Promise<void> => {
    const parsed_conc = Math.max(1, Math.min(8, Number(concurrency) || 1));
    const parsed_budget = budget.trim() === "" ? null : Number(budget);
    const budget_usd =
      parsed_budget !== null && Number.isFinite(parsed_budget)
        ? parsed_budget
        : null;

    // Resolve the chapter scope to send to the runner.
    // - If every chapter is selected → null (let the runner pull all
    //   pending segments project-wide). Equivalent to the legacy
    //   "translate everything" path.
    // - Otherwise → just the picked chapter ids.
    let resolved_chapter_ids: readonly string[] | null;
    if (chapters_with_counts && chapters_with_counts.length > 0) {
      if (selection.size === 0) {
        // Defensive: the Start button is disabled in this case, but
        // bail without firing a no-op batch.
        return;
      }
      const all_selected = chapters_with_counts.every((c) =>
        selection.has(c.id),
      );
      resolved_chapter_ids = all_selected ? null : Array.from(selection);
    } else {
      resolved_chapter_ids = chapter_ids ?? null;
    }

    onOpenChange(false);
    const input = {
      project_id,
      concurrency: parsed_conc,
      budget_usd,
      bypass_cache,
      chapter_ids: resolved_chapter_ids,
      pre_pass,
    };
    // When a batch is already running, enqueue this one rather than
    // erroring out. The runner drains the queue on idle. The label
    // keeps the curator-facing toast / status bar concise.
    const ch_label =
      resolved_chapter_ids === null
        ? "all pending"
        : resolved_chapter_ids.length === 1
          ? "1 chapter"
          : `${resolved_chapter_ids.length} chapters`;
    await start(input, {
      queue_if_busy: true,
      label: ch_label,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Translate batch</DialogTitle>
          <DialogDescription>
            Pick the chapters you want to translate, then start the batch.
            Cache hits cost nothing, so re-running over a populated cache
            is free.
            {pending_count !== undefined ? (
              <>
                {" "}
                <strong>{pending_count}</strong> segment
                {pending_count === 1 ? "" : "s"} pending in scope.
              </>
            ) : null}
            {active ? (
              <>
                {" "}
                <span className="font-medium text-amber-700 dark:text-amber-300">
                  A batch is currently running — this run will queue
                  behind it
                  {queue_size > 0
                    ? ` (${queue_size} already queued)`
                    : ""}
                  .
                </span>
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          onSubmit={(ev) => {
            ev.preventDefault();
            void onStart();
          }}
        >
        {/* Chapter picker */}
        <div className="mb-4 rounded-md border">
          <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-xs">
            <span className="font-semibold uppercase tracking-wider text-muted-foreground">
              Chapters
            </span>
            <span className="font-mono text-muted-foreground">
              {chapters_with_counts === null
                ? "loading…"
                : `${selection.size}/${chapters_with_counts.length} selected · ${selected_pending_total} pending`}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={select_pending}
                disabled={!chapters_with_counts}
                className="h-6 text-xs"
              >
                Pending
              </Button>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={select_all}
                disabled={!chapters_with_counts}
                className="h-6 text-xs"
              >
                All
              </Button>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={select_none}
                disabled={!chapters_with_counts}
                className="h-6 text-xs"
              >
                None
              </Button>
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {chapters_with_counts === null ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                Loading chapters…
              </div>
            ) : chapters_with_counts.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                No chapters in this project.
              </div>
            ) : (
              chapters_with_counts.map((ch) => {
                const checked = selection.has(ch.id);
                const label =
                  ch.title?.trim() || `Chapter ${ch.spine_idx + 1}`;
                return (
                  <label
                    key={ch.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 px-3 py-1.5 text-sm hover:bg-accent/40",
                      checked ? "bg-accent/20" : "",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle_chapter(ch.id)}
                    />
                    <span className="w-8 shrink-0 font-mono text-[11px] text-muted-foreground">
                      #{ch.spine_idx + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 font-mono text-[11px]",
                        ch.pending > 0
                          ? "border-primary/40 text-primary"
                          : "text-muted-foreground",
                      )}
                    >
                      {ch.pending} pending
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="b-concurrency">Concurrency</Label>
            <Input
              id="b-concurrency"
              type="number"
              min={1}
              max={8}
              value={concurrency}
              onChange={(e) => setConcurrency(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Parallel LLM calls. Default 1; raise only if the endpoint
              tolerates it.
            </p>
          </div>
          <div>
            <Label htmlFor="b-budget">Budget cap (USD)</Label>
            <Input
              id="b-budget"
              type="number"
              step="0.0001"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="(unlimited)"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Stops new work once cumulative cost crosses the cap.
            </p>
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <input
              id="b-bypass"
              type="checkbox"
              checked={bypass_cache}
              onChange={(e) => setBypassCache(e.target.checked)}
            />
            <Label htmlFor="b-bypass">
              Bypass cache (re-translate from scratch)
            </Label>
          </div>
          <div className="col-span-2 flex items-start gap-2">
            <input
              id="b-pre-pass"
              type="checkbox"
              className="mt-1"
              checked={pre_pass}
              onChange={(e) => setPrePass(e.target.checked)}
            />
            <div className="flex-1">
              <Label htmlFor="b-pre-pass">
                Run helper-LLM pre-pass per chapter
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Sniffs proper nouns and recurring phrases before
                translating, so the glossary is populated as you go.
                Adds one helper call per chapter.
              </p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              chapters_with_counts !== null &&
              chapters_with_counts.length > 0 &&
              selection.size === 0
            }
            title={
              active
                ? "A batch is already running — this run will be queued and start automatically."
                : undefined
            }
          >
            {chapters_with_counts &&
            chapters_with_counts.length > 0 &&
            selection.size === 0
              ? "Pick at least one chapter"
              : active
                ? selection.size === 1
                  ? "Queue 1 chapter"
                  : selection.size > 1 &&
                      chapters_with_counts &&
                      selection.size < chapters_with_counts.length
                    ? `Queue ${selection.size} chapters`
                    : "Queue batch"
                : selection.size === 1
                  ? "Translate 1 chapter"
                  : selection.size > 1 &&
                      chapters_with_counts &&
                      selection.size < chapters_with_counts.length
                    ? `Translate ${selection.size} chapters`
                    : "Start batch"}
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
