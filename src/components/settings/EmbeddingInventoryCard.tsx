/**
 * Project-level embedding inventory + re-embed action card.
 *
 * Renders inside Project Settings (or stand-alone — see prop docs).
 * Surfaces three things curators need when they switch the active
 * embedding model:
 *
 * 1. **What's embedded under what model.** A scope-by-scope
 *    histogram (segments, project glossary, attached Lore Books).
 *    The "active" column lights up green; other models render as
 *    grey "stale" rows that won't be retrievable until re-embedded.
 *
 * 2. **Re-embed everything.** Calls `reembedProject` against the
 *    active provider, batched through `runEmbeddingPass` so the
 *    audit trail (intake-runs, llm_calls) gets the same treatment
 *    as a regular intake. Lore Books are opt-in because they're
 *    shared across projects.
 *
 * 3. **Purge stale rows.** Drops vectors keyed under non-active
 *    models. Useful when the curator is sure they won't switch back
 *    and wants the IndexedDB quota back.
 *
 * The card hides itself when embeddings are disabled (active model
 * is `null`) so the screen stays clean for projects that never opt
 * in.
 */

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Layers, RotateCw, Trash2 } from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { openProjectDb } from "@/db/dexie";
import { readLlmConfig } from "@/db/library";
import {
  type ProjectEmbeddingOverrides,
  buildEmbeddingProvider,
  resolveEmbeddingConfig,
} from "@/llm/embeddings/factory";
import {
  type EmbeddingScopeStats,
  type ProjectEmbeddingInventory,
  getProjectEmbeddingInventory,
  purgeStaleEmbeddings,
  reembedProject,
} from "@/llm/embeddings/inventory";
import { EmbeddingError } from "@/llm/embeddings/base";

interface Props {
  project_id: string;
}

export function EmbeddingInventoryCard({ project_id }: Props): React.JSX.Element | null {
  const [active_model, setActiveModel] = React.useState<string | null | undefined>(
    undefined,
  );
  const [busy, setBusy] = React.useState(false);
  const [confirm_purge, setConfirmPurge] = React.useState(false);
  const [confirm_reembed, setConfirmReembed] = React.useState(false);
  const [include_lore, setIncludeLore] = React.useState(false);

  // Resolve the active embedding model for this project (library
  // config + per-project overrides). `useLiveQuery` re-fires when
  // either side changes, so the curator's edits in the override
  // card propagate without an explicit save.
  const project_overrides = useLiveQuery(async () => {
    if (!project_id) return null;
    const detail = await openProjectDb(project_id).projects.get(project_id);
    if (!detail?.llm_overrides) return null;
    try {
      return JSON.parse(detail.llm_overrides) as {
        embedding?: ProjectEmbeddingOverrides | null;
      };
    } catch {
      return null;
    }
  }, [project_id]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const library = await readLlmConfig();
        const overrides = project_overrides?.embedding ?? null;
        const resolved = resolveEmbeddingConfig(library, overrides);
        if (cancelled) return;
        setActiveModel(resolved?.model ?? null);
      } catch {
        if (!cancelled) setActiveModel(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project_overrides]);

  const inventory = useLiveQuery<ProjectEmbeddingInventory | null>(
    async (): Promise<ProjectEmbeddingInventory | null> => {
      if (!project_id || active_model === undefined) return null;
      try {
        return await getProjectEmbeddingInventory(project_id, active_model);
      } catch {
        return null;
      }
    },
    [project_id, active_model],
  );

  const onReembed = React.useCallback(async (): Promise<void> => {
    if (!project_id || !active_model) return;
    setBusy(true);
    try {
      const { provider } = await buildEmbeddingProvider();
      if (!provider) {
        toast.error(
          "No active embedding provider — pick one in Settings → Embeddings first.",
        );
        return;
      }
      const t0 = performance.now();
      const summary = await reembedProject(project_id, provider, {
        skip_lore: !include_lore,
      });
      const dt = Math.round(performance.now() - t0);
      const seg = summary.segments?.embedded ?? 0;
      toast.success(
        `Re-embedded ${seg} segment${seg === 1 ? "" : "s"} + ${summary.glossary_entries} glossary ` +
          `entr${summary.glossary_entries === 1 ? "y" : "ies"}` +
          (summary.lore_entries
            ? ` + ${summary.lore_entries} Lore-Book entries`
            : "") +
          ` in ${dt} ms.`,
        { duration: 8_000 },
      );
    } catch (err: unknown) {
      const msg =
        err instanceof EmbeddingError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      toast.error(`Re-embed failed: ${msg}`, { duration: 12_000 });
    } finally {
      setBusy(false);
      setConfirmReembed(false);
    }
  }, [project_id, active_model, include_lore]);

  const onPurge = React.useCallback(async (): Promise<void> => {
    if (!project_id || !active_model) return;
    setBusy(true);
    try {
      const purged = await purgeStaleEmbeddings(project_id, active_model);
      toast.success(
        `Purged ${purged} stale embedding row${purged === 1 ? "" : "s"}.`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Purge failed: ${msg}`);
    } finally {
      setBusy(false);
      setConfirmPurge(false);
    }
  }, [project_id, active_model]);

  if (active_model === undefined) return null;
  if (active_model === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="size-4 text-muted-foreground" />
            Embedding inventory
          </CardTitle>
          <CardDescription>
            Embeddings are off for this project. Pick a provider above (or
            in Settings → Embeddings) to enable retrieval.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!inventory) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="size-4 text-muted-foreground" />
            Embedding inventory
          </CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const total_stale =
    inventory.segment.stale +
    inventory.glossary_entry.stale +
    inventory.lore_books.reduce(
      (acc, b) => acc + b.glossary_entry.stale,
      0,
    );
  const total_missing_segments = Math.max(
    0,
    inventory.segment.total - inventory.segment.active,
  );
  const total_missing_glossary = Math.max(
    0,
    inventory.glossary_entry.total - inventory.glossary_entry.active,
  );

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="size-4 text-primary" />
            Embedding inventory
          </CardTitle>
          <CardDescription>
            Vectors are model-specific — switching models silently demotes
            existing rows to "stale" until you re-embed. The pipeline
            ranks only rows under the active model
            (<code className="font-mono text-[11px]">{active_model}</code>).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ScopeRow
            label="Segments"
            stats={inventory.segment}
            active_model={active_model}
            missing={total_missing_segments}
            unit="segment"
          />
          <ScopeRow
            label="Project glossary"
            stats={inventory.glossary_entry}
            active_model={active_model}
            missing={total_missing_glossary}
            unit="entry"
          />
          {inventory.lore_books.length > 0 ? (
            <div className="grid gap-2">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Attached Lore Books
              </div>
              {inventory.lore_books.map((lb) => (
                <ScopeRow
                  key={lb.lore_id}
                  label={lb.name ?? lb.lore_id}
                  stats={lb.glossary_entry}
                  active_model={active_model}
                  missing={Math.max(
                    0,
                    lb.glossary_entry.total - lb.glossary_entry.active,
                  )}
                  unit="entry"
                  variant="lore"
                />
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button
              type="button"
              size="sm"
              variant={total_missing_segments + total_missing_glossary > 0 ? "default" : "outline"}
              disabled={busy}
              onClick={() => setConfirmReembed(true)}
            >
              <RotateCw className="size-3.5" /> Re-embed everything
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || total_stale === 0}
              onClick={() => setConfirmPurge(true)}
              title={
                total_stale === 0
                  ? "No stale rows to purge."
                  : `Drop ${total_stale} row(s) keyed under non-active models.`
              }
            >
              <Trash2 className="size-3.5" /> Purge stale rows ({total_stale})
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirm_reembed} onOpenChange={setConfirmReembed}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-embed everything?</DialogTitle>
            <DialogDescription>
              This will run the active provider over every segment +
              glossary entry that doesn't yet have a vector under{" "}
              <code className="font-mono text-[11px]">{active_model}</code>.
              Existing rows (including stale ones) stay in the DB until
              you click Purge.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={include_lore}
                onChange={(ev) => setIncludeLore(ev.target.checked)}
                className="mt-0.5"
              />
              <span>
                Also re-embed attached Lore Books.{" "}
                <span className="text-muted-foreground">
                  Lore Books are shared across projects — re-embedding
                  here rewrites their vectors for everyone using them.
                </span>
              </span>
            </label>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirmReembed(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={() => void onReembed()} disabled={busy}>
              {busy ? "Re-embedding…" : "Start"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm_purge} onOpenChange={setConfirmPurge}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Purge {total_stale} stale row(s)?</DialogTitle>
            <DialogDescription>
              These rows were embedded with a model other than{" "}
              <code className="font-mono text-[11px]">{active_model}</code>.
              They aren't used by retrieval anymore. Deleting them frees
              IndexedDB quota — you can always re-embed later, but at
              the cost of a fresh provider call.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirmPurge(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void onPurge()}
              disabled={busy}
            >
              {busy ? "Purging…" : "Purge"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface ScopeRowProps {
  label: string;
  stats: EmbeddingScopeStats;
  active_model: string;
  missing: number;
  unit: string;
  variant?: "lore";
}

function ScopeRow({
  label,
  stats,
  active_model,
  missing,
  unit,
  variant,
}: ScopeRowProps): React.JSX.Element {
  return (
    <div
      className={
        variant === "lore"
          ? "rounded-md border bg-card/30 px-3 py-2 text-sm"
          : "text-sm"
      }
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">
          {stats.total} {unit}
          {stats.total === 1 ? "" : "s"}
        </span>
        {missing > 0 ? (
          <Badge variant="proposed" className="ml-auto">
            {missing} missing under {shortModel(active_model)}
          </Badge>
        ) : (
          <Badge variant="confirmed" className="ml-auto">
            All embedded
          </Badge>
        )}
      </div>
      {stats.by_model.length === 0 ? (
        <div className="mt-1 text-[12px] text-muted-foreground">
          No vectors yet — click Re-embed to populate.
        </div>
      ) : (
        <ul className="mt-1.5 grid gap-0.5 text-[12px]">
          {stats.by_model.map((entry) => (
            <li
              key={entry.model}
              className="flex items-center gap-2 font-mono"
            >
              <span
                className={
                  entry.model === active_model
                    ? "text-foreground"
                    : "text-muted-foreground line-through"
                }
              >
                {entry.model}
              </span>
              <span className="text-muted-foreground">
                · {entry.count} row{entry.count === 1 ? "" : "s"}
              </span>
              {entry.model === active_model ? (
                <Badge variant="confirmed" className="ml-auto">
                  active
                </Badge>
              ) : (
                <Badge variant="proposed" className="ml-auto">
                  stale
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function shortModel(model: string): string {
  if (model.length <= 28) return model;
  return `${model.slice(0, 26)}…`;
}
