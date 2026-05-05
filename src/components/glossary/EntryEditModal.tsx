/**
 * Glossary entry create / edit modal.
 *
 * Single dialog handles both flows. The shape is small enough that the
 * full form fits without tabs:
 *
 *   • Source term + comma-separated source aliases
 *   • Target term + comma-separated target aliases
 *   • Type / status / gender (selects)
 *   • Notes textarea
 *
 * On save we route through `createGlossaryEntry` for new rows or
 * `updateGlossaryEntry` + `setAliases` for edits, then optionally fire
 * a cascade re-translation when the target term changed on a confirmed
 * or locked row (mirrors `epublate.app.modals.GlossaryEditModal`).
 */

import * as React from "react";
import { toast } from "sonner";

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
import { Textarea } from "@/components/ui/textarea";
import {
  createGlossaryEntry,
  setAliases,
  updateGlossaryEntry,
} from "@/db/repo/glossary";
import {
  cascadeRetranslate,
  computeAffected,
  type CascadeCandidate,
} from "@/glossary/cascade";
import type { GlossaryEntryWithAliases } from "@/glossary/models";
import {
  GlossaryStatus,
  type EntityType,
  type GenderTag,
  type GlossaryStatusT,
} from "@/db/schema";

const TYPE_OPTIONS: EntityType[] = [
  "term",
  "character",
  "place",
  "organization",
  "event",
  "item",
  "date_or_time",
  "phrase",
  "other",
];
const STATUS_OPTIONS: GlossaryStatusT[] = [
  GlossaryStatus.PROPOSED,
  GlossaryStatus.CONFIRMED,
  GlossaryStatus.LOCKED,
];
const GENDER_OPTIONS: Array<GenderTag | ""> = [
  "",
  "feminine",
  "masculine",
  "neuter",
  "common",
  "unspecified",
];

interface EntryEditModalProps {
  project_id: string;
  entry: GlossaryEntryWithAliases | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSaved?(entry_id: string): void;
}

interface FormState {
  source_term: string;
  target_term: string;
  type: EntityType;
  status: GlossaryStatusT;
  gender: GenderTag | "";
  notes: string;
  source_aliases: string;
  target_aliases: string;
  source_known: boolean;
}

function blankForm(): FormState {
  return {
    source_term: "",
    target_term: "",
    type: "term",
    status: GlossaryStatus.PROPOSED,
    gender: "",
    notes: "",
    source_aliases: "",
    target_aliases: "",
    source_known: true,
  };
}

function fromEntry(ent: GlossaryEntryWithAliases): FormState {
  return {
    source_term: ent.entry.source_term ?? "",
    target_term: ent.entry.target_term,
    type: ent.entry.type,
    status: ent.entry.status,
    gender: ent.entry.gender ?? "",
    notes: ent.entry.notes ?? "",
    source_aliases: ent.source_aliases.join(", "),
    target_aliases: ent.target_aliases.join(", "),
    source_known: ent.entry.source_known,
  };
}

function parseAliases(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function EntryEditModal({
  project_id,
  entry,
  open,
  onOpenChange,
  onSaved,
}: EntryEditModalProps): React.JSX.Element {
  const [form, setForm] = React.useState<FormState>(() =>
    entry ? fromEntry(entry) : blankForm(),
  );
  const [busy, setBusy] = React.useState(false);
  const [pendingCascade, setPendingCascade] = React.useState<{
    candidates: CascadeCandidate[];
    prev_target_term: string | null;
    new_target_term: string | null;
  } | null>(null);

  React.useEffect(() => {
    if (open) setForm(entry ? fromEntry(entry) : blankForm());
  }, [open, entry]);

  const onSave = async (): Promise<void> => {
    setBusy(true);
    try {
      const target_term = form.target_term.trim();
      if (!target_term) {
        toast.error("Target term cannot be empty.");
        return;
      }
      const source_aliases = parseAliases(form.source_aliases);
      const target_aliases = parseAliases(form.target_aliases);
      const gender = form.gender === "" ? null : form.gender;

      if (entry === null) {
        const source_term = form.source_term.trim() || null;
        const created = await createGlossaryEntry(project_id, {
          project_id,
          source_term,
          target_term,
          type: form.type,
          status: form.status,
          gender,
          notes: form.notes.trim() || null,
          source_aliases,
          target_aliases,
          source_known: source_term !== null,
        });
        toast.success("Entry created.");
        onSaved?.(created.entry.id);
        onOpenChange(false);
        return;
      }

      const prev_target_term = entry.entry.target_term;
      const next_status = form.status;
      const target_changed = target_term !== prev_target_term;
      await updateGlossaryEntry(project_id, entry.entry.id, {
        target_term,
        status: next_status,
        type: form.type,
        gender,
        notes: form.notes.trim() || null,
        reason: target_changed ? "edit" : null,
      });
      await setAliases(project_id, entry.entry.id, {
        source_aliases,
        target_aliases,
      });
      onSaved?.(entry.entry.id);

      // Cascade preflight: only when the row is curator-trusted and
      // the target text actually changed; otherwise nothing depends
      // on the previous target term.
      const should_cascade =
        target_changed &&
        (next_status === GlossaryStatus.CONFIRMED ||
          next_status === GlossaryStatus.LOCKED);
      if (should_cascade) {
        const next_entry: GlossaryEntryWithAliases = {
          entry: {
            ...entry.entry,
            target_term,
            status: next_status,
            gender,
            type: form.type,
            notes: form.notes.trim() || null,
          },
          source_aliases: [...source_aliases].sort(),
          target_aliases: [...target_aliases].sort(),
        };
        const candidates = await computeAffected({
          project_id,
          entry: next_entry,
          prev_target_term,
        });
        if (candidates.length > 0) {
          setPendingCascade({
            candidates,
            prev_target_term,
            new_target_term: target_term,
          });
          return;
        }
      }
      toast.success("Entry saved.");
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Save failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const onConfirmCascade = async (): Promise<void> => {
    if (!entry || !pendingCascade) return;
    setBusy(true);
    try {
      const next_entry: GlossaryEntryWithAliases = {
        entry: {
          ...entry.entry,
          target_term: pendingCascade.new_target_term ?? entry.entry.target_term,
        },
        source_aliases: entry.source_aliases,
        target_aliases: entry.target_aliases,
      };
      const n = await cascadeRetranslate({
        project_id,
        entry: next_entry,
        prev_target_term: pendingCascade.prev_target_term,
        new_target_term: pendingCascade.new_target_term,
        candidates: pendingCascade.candidates,
        reason: "glossary edit",
      });
      toast.success(`Reset ${n} segment${n === 1 ? "" : "s"} to pending.`);
      setPendingCascade(null);
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Cascade failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const onSkipCascade = (): void => {
    toast.message("Skipped re-translation cascade.");
    setPendingCascade(null);
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open && pendingCascade === null} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {entry === null ? "New glossary entry" : "Edit glossary entry"}
            </DialogTitle>
            <DialogDescription>
              {entry === null
                ? "Curate a new lore-bible entry. Aliases are comma-separated."
                : "Editing a confirmed/locked target term schedules dependent segments for re-translation."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Label htmlFor="g-source">Source term</Label>
              <Input
                id="g-source"
                value={form.source_term}
                onChange={(e) =>
                  setForm({ ...form, source_term: e.target.value })
                }
                placeholder="e.g. House of Commons"
                autoFocus={entry === null}
              />
            </div>
            <div className="col-span-2">
              <Label htmlFor="g-source-aliases">
                Source aliases (comma-separated)
              </Label>
              <Input
                id="g-source-aliases"
                value={form.source_aliases}
                onChange={(e) =>
                  setForm({ ...form, source_aliases: e.target.value })
                }
                placeholder="the Commons, House"
              />
            </div>
            <div className="col-span-2">
              <Label htmlFor="g-target">Target term</Label>
              <Input
                id="g-target"
                value={form.target_term}
                onChange={(e) =>
                  setForm({ ...form, target_term: e.target.value })
                }
                placeholder="e.g. Câmara dos Comuns"
              />
            </div>
            <div className="col-span-2">
              <Label htmlFor="g-target-aliases">
                Target aliases (comma-separated)
              </Label>
              <Input
                id="g-target-aliases"
                value={form.target_aliases}
                onChange={(e) =>
                  setForm({ ...form, target_aliases: e.target.value })
                }
                placeholder="a Câmara"
              />
            </div>
            <div>
              <Label htmlFor="g-type">Type</Label>
              <select
                id="g-type"
                value={form.type}
                onChange={(e) =>
                  setForm({ ...form, type: e.target.value as EntityType })
                }
                className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="g-status">Status</Label>
              <select
                id="g-status"
                value={form.status}
                onChange={(e) =>
                  setForm({
                    ...form,
                    status: e.target.value as GlossaryStatusT,
                  })
                }
                className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="g-gender">Gender</Label>
              <select
                id="g-gender"
                value={form.gender}
                onChange={(e) =>
                  setForm({
                    ...form,
                    gender: e.target.value as GenderTag | "",
                  })
                }
                className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {GENDER_OPTIONS.map((g) => (
                  <option key={g} value={g}>
                    {g === "" ? "(unset)" : g}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <Label htmlFor="g-notes">Notes</Label>
              <Textarea
                id="g-notes"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={3}
                placeholder="Optional curator notes (visible in the LLM prompt)."
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void onSave()} disabled={busy}>
              {entry === null ? "Create" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {pendingCascade !== null ? (
        <Dialog open onOpenChange={(o) => !o && onSkipCascade()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Re-translate affected segments?</DialogTitle>
              <DialogDescription>
                {pendingCascade.candidates.length} segment
                {pendingCascade.candidates.length === 1 ? "" : "s"}
                {" "}touch this entry. Resetting them to pending lets the next
                batch translate them with the new target term:{" "}
                <strong>{pendingCascade.new_target_term}</strong>.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={onSkipCascade}
                disabled={busy}
              >
                Skip
              </Button>
              <Button
                type="button"
                onClick={() => void onConfirmCascade()}
                disabled={busy}
              >
                Reset {pendingCascade.candidates.length}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
