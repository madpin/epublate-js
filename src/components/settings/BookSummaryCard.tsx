/**
 * Project Settings → Book summary card.
 *
 * Shows the project's `book_summary` (the 150–250 word premise that
 * gets folded into the cacheable system prefix) with three primary
 * actions:
 *
 *   - **Generate from book.** Calls {@link useRunBookSummary} → the
 *     helper-LLM service. Mirrors the on-demand intake flow.
 *   - **Save.** Persists the curator's manual edits via
 *     {@link updateProjectSettings}.
 *   - **Clear.** Drops the summary entirely (the prompt block
 *     disappears even when{" "}
 *     <code>include_book_summary</code> is on).
 *
 * The textarea shows a live token-count badge so curators can see
 * how much they're spending per call. The card warns when the
 * summary is empty <em>and</em>{" "}
 * <code>include_book_summary</code> is on (the block is always
 * rendered but as an empty wrapper) and offers one-click fixes.
 */

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BookOpen, Eraser, Save, Sparkles } from "lucide-react";
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
import { FieldHelp } from "@/components/ui/field-help";
import { Textarea } from "@/components/ui/textarea";
import { openProjectDb } from "@/db/dexie";
import { listIntakeRuns } from "@/db/repo/intake";
import { updateProjectSettings } from "@/db/repo/projects";
import { IntakeRunKind } from "@/db/schema";
import { useRunBookSummary } from "@/hooks/useRunBookSummary";
import { countTokensSync } from "@/llm/tokens";

interface BookSummaryCardProps {
  project_id: string;
  /** Current persisted summary (snapshot from the project row). */
  value: string | null | undefined;
  /** Whether `include_book_summary` is enabled in `prompt_options`. */
  block_enabled: boolean;
}

export function BookSummaryCard({
  project_id,
  value,
  block_enabled,
}: BookSummaryCardProps): React.JSX.Element {
  const [draft, setDraft] = React.useState(value ?? "");
  const [busy, setBusy] = React.useState(false);
  const { start: runBookSummary, running } = useRunBookSummary();

  // Re-sync when the persisted value changes (helper-LLM finished).
  React.useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  const last_run = useLiveQuery(
    async () => {
      const rows = await listIntakeRuns(project_id, {
        kind: IntakeRunKind.BOOK_SUMMARY,
        limit: 1,
      });
      return rows[0] ?? null;
    },
    [project_id],
    null,
  );

  const dirty = (draft ?? "") !== (value ?? "");
  const tokens = React.useMemo(() => {
    const t = (draft ?? "").trim();
    return t ? countTokensSync(t) : 0;
  }, [draft]);
  const word_count = React.useMemo(() => {
    const t = (draft ?? "").trim();
    if (!t) return 0;
    return t.split(/\s+/).length;
  }, [draft]);

  const onSave = async (): Promise<void> => {
    setBusy(true);
    try {
      await updateProjectSettings(project_id, { book_summary: draft });
      toast.success(
        draft.trim() ? "Book summary saved." : "Book summary cleared.",
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
      await updateProjectSettings(project_id, { book_summary: null });
      toast.success("Book summary cleared.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not clear: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const onGenerate = async (): Promise<void> => {
    const result = await runBookSummary(project_id);
    // The hook persists the new summary itself; useLiveQuery on the
    // parent route will push a fresh `value` down and our useEffect
    // syncs `draft`. Toast already fired.
    if (result?.summary) {
      // Force a refresh of the project row in case the parent isn't
      // re-running its query (some paths debounce).
      const db = openProjectDb(project_id);
      await db.projects.get(project_id);
    }
  };

  const status = (() => {
    if (running) return "running";
    if (!draft.trim()) return "absent";
    if (dirty) return "dirty";
    return "present";
  })();

  return (
    <Card id="book-summary">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="size-4 text-primary" />
          Book summary
          <StatusBadge status={status} block_enabled={block_enabled} />
        </CardTitle>
        <CardDescription>
          150–250 word premise of the book. Lands in the cacheable
          system prefix — it ships with every translation prompt,
          so a single edit invalidates the cache once and then sits
          in the LLM's prefix-cache for the rest of the run.
          Generate it from the book's first ~30 segments to seed
          the helper-LLM, then refine by hand.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-1.5">
          <FieldHelp
            htmlFor="bs-summary"
            label="Summary"
            help={
              <>
                <p>
                  Aim for one paragraph, 150–250 words, written in
                  English for a translator audience (not in the
                  source's narrative voice). Mention the setting,
                  era, narrator's POV, and key relationships —{" "}
                  <em>without</em> spoilers from later chapters.
                </p>
                <p className="mt-2">
                  The "Generate" button runs the helper-LLM over
                  the book's opening segments only, never later
                  chapters, so the summary stays spoiler-light.
                </p>
              </>
            }
          />
          <Textarea
            id="bs-summary"
            rows={8}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy || running}
            placeholder="Empty — generate from the book's opening segments or paste your own."
            className="font-mono text-[12px]"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>
              {word_count} word{word_count === 1 ? "" : "s"} ·{" "}
              <code className="font-mono">{tokens.toLocaleString()}</code>{" "}
              tokens
            </span>
            {last_run ? (
              <span>
                Last generated{" "}
                {new Date(last_run.finished_at).toLocaleString()} via{" "}
                <code className="font-mono">{last_run.helper_model}</code>{" "}
                · ${last_run.cost_usd.toFixed(4)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || running || !draft.trim()}
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
            disabled={busy || running}
            onClick={() => void onGenerate()}
            className="gap-1.5"
          >
            <Sparkles className="size-3.5" />
            {running
              ? "Generating…"
              : draft.trim()
                ? "Regenerate from book"
                : "Generate from book"}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || running || !dirty}
            onClick={() => void onSave()}
            className="gap-1.5"
          >
            <Save className="size-3.5" />
            {busy ? "Saving…" : dirty ? "Save edits" : "Saved"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({
  status,
  block_enabled,
}: {
  status: "running" | "absent" | "dirty" | "present";
  block_enabled: boolean;
}): React.JSX.Element | null {
  if (status === "running") {
    return (
      <Badge variant="outline" className="text-[10px]">
        Generating…
      </Badge>
    );
  }
  if (status === "absent") {
    return (
      <Badge variant="outline" className="text-[10px] text-muted-foreground">
        {block_enabled ? "absent (block on)" : "absent"}
      </Badge>
    );
  }
  if (status === "dirty") {
    return (
      <Badge variant="warning" className="text-[10px]">
        unsaved changes
      </Badge>
    );
  }
  return (
    <Badge variant="success" className="text-[10px]">
      present
    </Badge>
  );
}
