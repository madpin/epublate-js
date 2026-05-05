/**
 * "Show occurrences" modal for a glossary entry.
 *
 * Lists every recorded `entity_mention` row alongside its segment +
 * chapter context, so the curator can quickly verify that every place
 * the term appears was translated consistently.
 */

import * as React from "react";
import { Link } from "react-router-dom";
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
import {
  listOccurrences,
  type OccurrenceRow,
} from "@/db/repo/glossary";
import type { GlossaryEntryWithAliases } from "@/glossary/models";

interface OccurrencesModalProps {
  project_id: string;
  entry: GlossaryEntryWithAliases | null;
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function OccurrencesModal({
  project_id,
  entry,
  open,
  onOpenChange,
}: OccurrencesModalProps): React.JSX.Element | null {
  const occurrences = useLiveQuery<OccurrenceRow[] | undefined>(
    async () => {
      if (!entry || !open) return undefined;
      return listOccurrences(project_id, entry.entry.id);
    },
    [project_id, entry?.entry.id, open],
  );

  if (!entry) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            Occurrences of{" "}
            <code className="font-mono">{entry.entry.source_term ?? "—"}</code>
          </DialogTitle>
          <DialogDescription>
            Every recorded mention of this entry's source term across the
            project. Click an occurrence to jump to that segment in the
            Reader.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto rounded-md border">
          {occurrences === undefined ? (
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          ) : occurrences.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No occurrences recorded yet — translate at least one segment that
              touches this term to populate this list.
            </div>
          ) : (
            <ul className="divide-y">
              {occurrences.map((o) => {
                const before = o.source_text.slice(
                  0,
                  o.source_span_start ?? 0,
                );
                const hit = o.source_text.slice(
                  o.source_span_start ?? 0,
                  o.source_span_end ?? 0,
                );
                const after = o.source_text.slice(o.source_span_end ?? 0);
                return (
                  <li key={o.mention_id} className="px-3 py-2 text-sm">
                    <Link
                      to={`/project/${project_id}/reader?ch=${o.chapter_id}#seg-${o.segment_id}`}
                      className="block hover:bg-accent/30"
                      onClick={() => onOpenChange(false)}
                    >
                      <div className="text-[11px] font-mono text-muted-foreground">
                        Ch {o.chapter_spine_idx + 1}
                        {o.chapter_title ? ` · ${o.chapter_title}` : ""} · seg{" "}
                        {o.segment_idx + 1}
                      </div>
                      <div className="mt-0.5 leading-relaxed">
                        {before}
                        <mark className="rounded bg-warning/30 px-0.5">
                          {hit}
                        </mark>
                        {after}
                      </div>
                      {o.target_text ? (
                        <div className="mt-0.5 text-xs text-muted-foreground italic">
                          → {o.target_text}
                        </div>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
