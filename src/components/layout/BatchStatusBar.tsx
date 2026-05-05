/**
 * Persistent batch status bar pinned above the main content area.
 *
 * Shows the running batch's progress, cost, ETA estimate, cancel
 * button, and a dismiss button once the run is finished. Re-attaches
 * across navigation because it lives in the AppShell — the curator
 * can move between Reader, Glossary, Inbox, etc. and still see the
 * meter.
 */

import * as React from "react";
import { Link } from "react-router-dom";
import { Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useBatchStore } from "@/state/batch";
import { formatCost } from "@/lib/numbers";
import { cn } from "@/lib/utils";

export function BatchStatusBar(): React.JSX.Element | null {
  const active = useBatchStore((s) => s.active);
  const queue = useBatchStore((s) => s.queue);
  const cancel = useBatchStore((s) => s.cancel);
  const dismiss = useBatchStore((s) => s.dismiss);
  const removeQueued = useBatchStore((s) => s.removeQueued);

  if (!active) return null;

  const { summary, finished, final_status, paused_reason } = active;
  const total = summary.total;
  const done =
    summary.translated + summary.cached + summary.flagged + summary.failed;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const eta_s = computeEta(summary);

  const tone =
    final_status === "paused"
      ? "border-warning/40 bg-warning/10"
      : final_status === "cancelled"
        ? "border-muted-foreground/30 bg-muted/30"
        : final_status === "completed"
          ? "border-success/40 bg-success/10"
          : "border-primary/40 bg-primary/10";

  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-4 py-1.5 text-xs",
        tone,
      )}
    >
      {!finished ? (
        <Loader2 className="size-3.5 animate-spin text-primary" />
      ) : null}
      <Link
        to={`/project/${active.project_id}/reader`}
        className="font-medium hover:underline"
      >
        {active.project_name}
      </Link>
      <div className="font-mono">
        {done}/{total} ({pct}%)
      </div>
      <div className="font-mono text-muted-foreground">
        {summary.translated} translated · {summary.cached} cached ·{" "}
        {summary.flagged} flagged · {summary.failed} failed
      </div>
      <div className="font-mono">{formatCost(summary.cost_usd)}</div>
      {!finished && eta_s !== null ? (
        <div className="font-mono text-muted-foreground">
          ETA {formatDuration(eta_s)}
        </div>
      ) : null}
      {finished && paused_reason ? (
        <div className="truncate text-warning" title={paused_reason}>
          {paused_reason}
        </div>
      ) : null}
      {queue.length > 0 ? (
        <div
          className="flex items-center gap-1 rounded border border-dashed border-foreground/20 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          title={queue
            .map(
              (q, i) =>
                `${i + 1}. ${q.project_name} · ${q.label}`,
            )
            .join("\n")}
        >
          <span>+{queue.length} queued</span>
          {queue.length > 0 ? (
            <button
              type="button"
              className="rounded text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              onClick={() => removeQueued(queue[queue.length - 1]!.id)}
              aria-label="Remove last queued batch"
              title="Remove the most recently queued batch"
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="ml-auto flex items-center gap-1">
        {!finished ? (
          <Button size="sm" variant="outline" onClick={() => cancel()}>
            Cancel
          </Button>
        ) : (
          <button
            type="button"
            onClick={() => dismiss()}
            className="flex size-6 items-center justify-center rounded hover:bg-accent"
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function computeEta(summary: {
  total: number;
  translated: number;
  cached: number;
  flagged: number;
  failed: number;
  elapsed_s: number;
}): number | null {
  const done =
    summary.translated + summary.cached + summary.flagged + summary.failed;
  if (done <= 0 || summary.elapsed_s <= 0) return null;
  const rate = done / summary.elapsed_s;
  const remaining = summary.total - done;
  if (remaining <= 0) return 0;
  return remaining / Math.max(rate, 1e-6);
}

function formatDuration(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
