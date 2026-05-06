/**
 * Project Settings → Prompt options card.
 *
 * Surfaces every toggleable {@link PromptOptions} flag as a labelled
 * checkbox with a {@link FieldHelp} tooltip explaining the cache /
 * cost / consistency trade-off. Saves go through
 * {@link updateProjectSettings} so the UI side never holds stale
 * state — the {@link PromptSimulatorCard} re-renders against the
 * persisted row via its own `useLiveQuery`.
 *
 * The glossary block is intentionally not exposed here — it's the
 * validator's contract; toggling it would just generate more flagged
 * segments. The card explains that in the description.
 */

import * as React from "react";
import { Sliders } from "lucide-react";
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
import {
  DEFAULT_PROMPT_OPTIONS,
  resolvePromptOptions,
  type PromptOptions,
} from "@/core/prompt_options";
import { updateProjectSettings } from "@/db/repo/projects";

interface PromptOptionRowDef {
  key: keyof PromptOptions;
  label: string;
  help: React.ReactNode;
  /** Cache-effect badge text, e.g. "system prefix" or "user tail". */
  badge: string;
}

const ROWS: ReadonlyArray<PromptOptionRowDef> = [
  {
    key: "include_language_notes",
    label: "Language notes",
    badge: "system prefix",
    help: (
      <>
        <p>
          Per-pair grammar notes — particle round-trips,
          quote-style, particle suffixes — that the translator pinned
          to the system prompt. Disabling skips them.
        </p>
        <p className="mt-2">
          <strong>Trade-off.</strong> Saves a few hundred tokens per
          call, but languages with non-trivial particle grammars
          (Japanese, Korean) lose a stable hand-rail; some
          translations may flag for boundary issues.
        </p>
      </>
    ),
  },
  {
    key: "include_style_guide",
    label: "Style guide",
    badge: "system prefix",
    help: (
      <>
        <p>
          The project's style preset / custom style block. Sits in
          the cacheable system prefix.
        </p>
        <p className="mt-2">
          <strong>Trade-off.</strong> Disabling produces a more
          literal translation. Useful for technical or reference
          books where the curator wants the model to ignore the
          tone preset entirely.
        </p>
      </>
    ),
  },
  {
    key: "include_book_summary",
    label: "Book summary",
    badge: "system prefix",
    help: (
      <>
        <p>
          The 150–250 word premise drafted from the book's opening
          segments. Helps the model keep tone and pronouns
          consistent across chapters.
        </p>
        <p className="mt-2">
          <strong>Trade-off.</strong> The summary lands in every
          translation prompt — that's a cost. Disable for short or
          technical books where the helper-LLM premise wouldn't
          carry useful information anyway.
        </p>
      </>
    ),
  },
  {
    key: "include_target_only",
    label: "Target-only terms",
    badge: "system prefix",
    help: (
      <>
        <p>
          Soft-locked target spellings (e.g. project-specific
          spellings of proper nouns) that the validator flags
          rather than rejects.
        </p>
        <p className="mt-2">
          <strong>Trade-off.</strong> When disabled, the model
          stops seeing the spellings up-front. Curators usually
          keep this on — it's small and the validator still
          enforces locked entries either way.
        </p>
      </>
    ),
  },
  {
    key: "include_chapter_notes",
    label: "Chapter notes",
    badge: "user tail",
    help: (
      <>
        <p>
          Per-chapter notes (POV switch, scene label, recurring
          imagery). Lives in the per-segment user message so the
          system prefix stays cacheable across chapters.
        </p>
        <p className="mt-2">
          <strong>Trade-off.</strong> Disabling skips it entirely
          even when{" "}
          <code className="font-mono">chapters.notes</code> is
          populated. Re-enable when you want the model to keep
          POV / scene awareness across segments in a chapter.
        </p>
      </>
    ),
  },
  {
    key: "include_proposed_hints",
    label: "Proposed glossary hints",
    badge: "user tail",
    help: (
      <>
        <p>
          Soft-suggested spellings for{" "}
          <em>proposed</em> glossary entries that haven't been
          promoted to confirmed yet, surfaced in the user message
          when an embedding provider is configured.
        </p>
        <p className="mt-2">
          <strong>Trade-off.</strong> Locked / confirmed entries
          are always sent (they're the validator's contract); only
          the unvetted hints disappear. Disable when you want the
          model to ignore the helper-LLM's draft suggestions.
        </p>
      </>
    ),
  },
  {
    key: "include_recent_context",
    label: "Recent context",
    badge: "user tail",
    help: (
      <>
        <p>
          The last N source/target pairs from the same chapter,
          picked according to the project's{" "}
          <em>Context window</em> mode. Keeps tone and pronouns
          consistent across paragraphs.
        </p>
        <p className="mt-2">
          <strong>Trade-off.</strong> Disabling is a hard override
          — the block is skipped even when{" "}
          <code className="font-mono">context_mode</code> is set
          to <code>previous</code>. Cheaper, but the model loses
          its cross-segment continuity hand-rail.
        </p>
      </>
    ),
  },
];

interface PromptOptionsCardProps {
  project_id: string;
  /**
   * Current persisted value (parsed from the project row). The card
   * resolves missing fields against {@link DEFAULT_PROMPT_OPTIONS}.
   */
  value: Partial<PromptOptions> | null | undefined;
  /**
   * Optional notification when the curator persists a new value —
   * used by the Prompt Simulator card to refresh its preview.
   */
  on_change?: (next: PromptOptions) => void;
}

export function PromptOptionsCard({
  project_id,
  value,
  on_change,
}: PromptOptionsCardProps): React.JSX.Element {
  const resolved = React.useMemo(() => resolvePromptOptions(value), [value]);
  const [draft, setDraft] = React.useState<PromptOptions>(resolved);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setDraft(resolved);
  }, [resolved]);

  const dirty = React.useMemo(() => {
    return ROWS.some((row) => draft[row.key] !== resolved[row.key]);
  }, [draft, resolved]);

  const setFlag = (key: keyof PromptOptions, next: boolean): void => {
    setDraft((prev) => ({ ...prev, [key]: next }));
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await updateProjectSettings(project_id, { prompt_options: draft });
      toast.success("Prompt options saved.");
      on_change?.(draft);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not save: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const reset_defaults = async (): Promise<void> => {
    setDraft({ ...DEFAULT_PROMPT_OPTIONS });
    setBusy(true);
    try {
      await updateProjectSettings(project_id, {
        prompt_options: DEFAULT_PROMPT_OPTIONS,
      });
      toast.success("Reset to defaults.");
      on_change?.({ ...DEFAULT_PROMPT_OPTIONS });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not save: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card id="prompt-options">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sliders className="size-4 text-primary" />
          Prompt options
        </CardTitle>
        <CardDescription>
          Toggle which blocks the translator prompt includes.
          Disabling a <em>system-prefix</em> block flips the cache
          key for every segment in the project; disabling a{" "}
          <em>user-tail</em> block only changes the per-segment
          tail. The glossary is always on — it's the validator's
          contract.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {ROWS.map((row) => (
          <PromptOptionRow
            key={row.key}
            row={row}
            checked={draft[row.key]}
            disabled={busy}
            onCheckedChange={(v) => setFlag(row.key, v)}
          />
        ))}
        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void reset_defaults()}
          >
            Reset to defaults
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || !dirty}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : dirty ? "Save options" : "Saved"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PromptOptionRow({
  row,
  checked,
  disabled,
  onCheckedChange,
}: {
  row: PromptOptionRowDef;
  checked: boolean;
  disabled: boolean;
  onCheckedChange(v: boolean): void;
}): React.JSX.Element {
  const id = `po-${row.key}`;
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-md border bg-card/50 p-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange(e.target.checked)}
        className="mt-1 size-4 accent-primary"
      />
      <div className="min-w-0">
        <FieldHelp htmlFor={id} label={row.label} help={row.help} />
      </div>
      <Badge
        variant={row.badge === "system prefix" ? "secondary" : "outline"}
        className="whitespace-nowrap text-[10px]"
      >
        {row.badge}
      </Badge>
    </div>
  );
}
