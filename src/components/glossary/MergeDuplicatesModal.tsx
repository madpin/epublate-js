/**
 * Cleanup duplicates flow.
 *
 * Buckets the project's glossary into near-duplicate groups via
 * `findNearDuplicates`, lets the curator pick a winner per group, and
 * folds the rest in via `mergeGlossaryEntries`. Mirrors
 * `epublate.app.modals.GlossaryCleanupDuplicatesModal`.
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
import { Badge } from "@/components/ui/badge";
import {
  listGlossaryEntries,
  mergeGlossaryEntries,
} from "@/db/repo/glossary";
import { findNearDuplicates } from "@/glossary/dedup";
import type { GlossaryEntryWithAliases } from "@/glossary/models";
import { GlossaryStatus } from "@/db/schema";

interface MergeDuplicatesModalProps {
  project_id: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}

interface GroupState {
  /** Sorted "winner-first" group from `findNearDuplicates`. */
  members: GlossaryEntryWithAliases[];
  /** Curator-selected winner id; defaults to members[0]. */
  winner_id: string;
  /** True if this group is checked for merging. */
  enabled: boolean;
}

function statusBadgeVariant(status: string): "locked" | "confirmed" | "proposed" {
  if (status === GlossaryStatus.LOCKED) return "locked";
  if (status === GlossaryStatus.CONFIRMED) return "confirmed";
  return "proposed";
}

export function MergeDuplicatesModal({
  project_id,
  open,
  onOpenChange,
}: MergeDuplicatesModalProps): React.JSX.Element {
  const [groups, setGroups] = React.useState<GroupState[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [showConfirm, setShowConfirm] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setLoading(true);
    void (async () => {
      try {
        const all = await listGlossaryEntries(project_id);
        const found = findNearDuplicates(all);
        setGroups(
          found.map((members) => ({
            members,
            winner_id: members[0]!.entry.id,
            enabled: true,
          })),
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [open, project_id]);

  const onMerge = async (): Promise<void> => {
    setBusy(true);
    try {
      let total_folded = 0;
      for (const g of groups) {
        if (!g.enabled) continue;
        const losers = g.members
          .filter((m) => m.entry.id !== g.winner_id)
          .map((m) => m.entry.id);
        if (!losers.length) continue;
        const folded = await mergeGlossaryEntries(project_id, {
          winner_id: g.winner_id,
          loser_ids: losers,
          reason: "cleanup duplicates",
        });
        total_folded += folded;
      }
      toast.success(
        `Folded ${total_folded} entr${total_folded === 1 ? "y" : "ies"} into winners.`,
      );
      setShowConfirm(false);
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Merge failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  // Summary numbers used by the confirmation modal.
  const enabled_groups = groups.filter((g) => g.enabled);
  const total_losers = enabled_groups.reduce(
    (acc, g) => acc + g.members.filter((m) => m.entry.id !== g.winner_id).length,
    0,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Cleanup duplicates</DialogTitle>
          <DialogDescription>
            Near-duplicate groups detected via canonical-form + bounded
            Levenshtein. Pick a winner per group; losers are folded in as
            aliases.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto rounded-md border">
          {loading ? (
            <div className="p-4 text-sm text-muted-foreground">Scanning…</div>
          ) : groups.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No near-duplicates found. Glossary looks clean.
            </div>
          ) : (
            <ul className="divide-y">
              {groups.map((g, gi) => (
                <li key={gi} className="px-3 py-2 text-sm">
                  <div className="mb-1 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={g.enabled}
                      onChange={(e) =>
                        setGroups((cur) =>
                          cur.map((cg, i) =>
                            i === gi ? { ...cg, enabled: e.target.checked } : cg,
                          ),
                        )
                      }
                    />
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Group {gi + 1}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {g.members.map((m) => (
                      <li
                        key={m.entry.id}
                        className="flex items-baseline gap-2 rounded px-2 py-1 hover:bg-accent/30"
                      >
                        <input
                          type="radio"
                          name={`winner-${gi}`}
                          checked={g.winner_id === m.entry.id}
                          onChange={() =>
                            setGroups((cur) =>
                              cur.map((cg, i) =>
                                i === gi
                                  ? { ...cg, winner_id: m.entry.id }
                                  : cg,
                              ),
                            )
                          }
                          disabled={!g.enabled}
                        />
                        <Badge
                          variant={statusBadgeVariant(m.entry.status)}
                          className="shrink-0"
                        >
                          {m.entry.status}
                        </Badge>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {m.entry.type}
                        </span>
                        <span className="min-w-0 flex-1">
                          <strong>{m.entry.source_term ?? "—"}</strong> →{" "}
                          {m.entry.target_term}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
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
          <Button
            type="button"
            onClick={() => setShowConfirm(true)}
            disabled={busy || groups.length === 0 || total_losers === 0}
          >
            Merge selected ({total_losers})
          </Button>
        </DialogFooter>
      </DialogContent>

      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm merge</DialogTitle>
            <DialogDescription>
              Folding{" "}
              <strong>
                {total_losers} entr{total_losers === 1 ? "y" : "ies"}
              </strong>{" "}
              from{" "}
              <strong>
                {enabled_groups.length} group
                {enabled_groups.length === 1 ? "" : "s"}
              </strong>{" "}
              into their winners. Loser entries become aliases on the
              winner. This is recorded in the revision log so you can
              audit it later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => setShowConfirm(false)}
              disabled={busy}
            >
              Back
            </Button>
            <Button
              type="button"
              onClick={() => void onMerge()}
              disabled={busy}
            >
              {busy ? "Merging…" : "Merge"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
