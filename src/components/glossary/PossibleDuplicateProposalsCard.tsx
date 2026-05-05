/**
 * Possible duplicate proposals (Phase 5).
 *
 * Surfaces clusters of `proposed` glossary entries that an embedding
 * provider thinks are semantic duplicates. The cluster oracle is
 * `findEmbeddingDuplicates` (cosine ≥ 0.92, same `type`); merge
 * actions reuse `mergeGlossaryEntries` so the curator's existing
 * "merge into the winner, fold losers as aliases" muscle memory
 * carries over.
 *
 * Shows nothing — gracefully — when:
 *   - no embedding provider is configured,
 *   - the project has fewer than 2 proposed entries with vectors,
 *   - or the cosine scan finds no clusters above threshold.
 *
 * Best-effort: failures collapse to an empty card so the inbox
 * proper keeps working even if Dexie or the provider misbehave.
 */

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Layers } from "lucide-react";
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
  listEmbeddingsByScope,
} from "@/db/repo/embeddings";
import {
  listGlossaryEntries,
  mergeGlossaryEntries,
} from "@/db/repo/glossary";
import {
  findEmbeddingDuplicates,
  type EmbeddingDuplicateGroup,
} from "@/glossary/dedup";
import { openProjectDb } from "@/db/dexie";
import { readLlmConfig } from "@/db/library";
import {
  type ProjectEmbeddingOverrides,
  resolveEmbeddingConfig,
} from "@/llm/embeddings/factory";
import { GlossaryStatus } from "@/db/schema";

interface PossibleDuplicateProposalsCardProps {
  project_id: string;
}

export function PossibleDuplicateProposalsCard({
  project_id,
}: PossibleDuplicateProposalsCardProps): React.JSX.Element | null {
  // Resolve the active embedding model so we know which vector rows
  // to scan. Done as a one-shot effect rather than `useLiveQuery`
  // because the model is global config (not in this project DB).
  const [model, setModel] = React.useState<string | null>(null);
  const [enabled, setEnabled] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const library = await readLlmConfig();
        const detail = await openProjectDb(project_id).projects.get(
          project_id,
        );
        let overrides: ProjectEmbeddingOverrides | null = null;
        if (detail?.llm_overrides) {
          try {
            const parsed = JSON.parse(detail.llm_overrides) as {
              embedding?: ProjectEmbeddingOverrides | null;
            };
            overrides = parsed.embedding ?? null;
          } catch {
            overrides = null;
          }
        }
        const resolved = resolveEmbeddingConfig(library, overrides);
        if (cancelled) return;
        if (!resolved) {
          setEnabled(false);
          return;
        }
        setEnabled(true);
        setModel(resolved.model);
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project_id]);

  // Re-runs on every glossary mutation thanks to `useLiveQuery`. The
  // O(n²) scan is cheap for the proposed-entry counts we expect (≤
  // ~500 entries per project), but if it ever shows up in the
  // profiler we can debounce here.
  const groups = useLiveQuery<EmbeddingDuplicateGroup[]>(
    async (): Promise<EmbeddingDuplicateGroup[]> => {
      if (!project_id || !model || !enabled) return [];
      try {
        const proposed = await listGlossaryEntries(project_id, {
          status: GlossaryStatus.PROPOSED,
        });
        if (proposed.length < 2) return [];
        const rows = await listEmbeddingsByScope(
          "project",
          project_id,
          "glossary_entry",
          model,
        );
        if (rows.length < 2) return [];
        return findEmbeddingDuplicates(proposed, rows);
      } catch {
        return [];
      }
    },
    [project_id, model, enabled],
  ) ?? [];

  const [busy_root, setBusyRoot] = React.useState<string | null>(null);

  const onMerge = React.useCallback(
    async (group: EmbeddingDuplicateGroup): Promise<void> => {
      if (group.members.length < 2) return;
      const winner_id = group.members[0]!.entry.id;
      const loser_ids = group.members
        .slice(1)
        .map((m) => m.entry.id);
      setBusyRoot(winner_id);
      try {
        const folded = await mergeGlossaryEntries(project_id, {
          winner_id,
          loser_ids,
          reason: `inbox dedup: cosine ≥ ${group.max_similarity.toFixed(2)}`,
        });
        toast.success(
          `Folded ${folded} entr${folded === 1 ? "y" : "ies"} into "${
            group.members[0]!.entry.source_term ??
            group.members[0]!.entry.target_term
          }".`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Merge failed: ${msg}`);
      } finally {
        setBusyRoot(null);
      }
    },
    [project_id],
  );

  // We hide the card entirely until we know whether embeddings are
  // on. This keeps the Inbox grid layout stable for legacy projects
  // and avoids a "flash of empty card" when the resolver is racing.
  if (enabled === null) return null;
  if (!enabled) return null;
  if (!groups || groups.length === 0) return null;

  return (
    <Card
      className="lg:col-span-2"
      data-testid="possible-duplicate-proposals"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Layers className="size-4 text-primary" /> Possible duplicate proposals
        </CardTitle>
        <CardDescription>
          Proposed entries with cosine ≥ 0.92 and the same type. Merging
          folds losers in as aliases on the winner — the same flow as
          Glossary → Cleanup duplicates.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y border-y">
          {groups.map((group) => {
            const winner = group.members[0]!;
            const winner_id = winner.entry.id;
            const losers = group.members.slice(1);
            return (
              <li key={winner_id} className="px-4 py-3 text-sm">
                <div className="mb-2 flex items-baseline gap-2">
                  <Badge variant="proposed">{winner.entry.type}</Badge>
                  <span className="text-[11px] font-mono text-muted-foreground">
                    cosine {group.max_similarity.toFixed(2)}
                  </span>
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {group.members.length} proposals in cluster
                  </span>
                </div>
                <div className="space-y-1 pl-1 text-[13px]">
                  <div className="flex items-baseline gap-2">
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                      Winner
                    </span>
                    <strong>{winner.entry.source_term ?? "—"}</strong>
                    <span className="text-muted-foreground">→</span>
                    <span>{winner.entry.target_term}</span>
                  </div>
                  {losers.map((m) => (
                    <div
                      key={m.entry.id}
                      className="flex items-baseline gap-2 text-muted-foreground"
                    >
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
                        Fold-in
                      </span>
                      <span>{m.entry.source_term ?? "—"}</span>
                      <span>→</span>
                      <span>{m.entry.target_term}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex gap-1.5">
                  <Button
                    size="sm"
                    onClick={() => void onMerge(group)}
                    disabled={busy_root === winner_id}
                  >
                    {busy_root === winner_id
                      ? "Merging…"
                      : `Merge ${losers.length} into winner`}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
