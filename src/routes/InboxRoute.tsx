/**
 * Inbox screen (mirrors `epublate.app.screens.inbox`).
 *
 * Three buckets:
 *   1. Flagged segments — `status === FLAGGED` rows, with their
 *      violation list (read off the most recent `segment.flagged`
 *      event) so the curator can fix or accept-anyway in one click.
 *   2. Proposed glossary entries — auto-proposed candidates that need
 *      curator promotion to `confirmed`/`locked`.
 *   3. Recent alerts — batch failures, pauses, and other inbox-relevant
 *      events.
 *
 * No virtualization yet — most projects accumulate < a few hundred
 * flagged rows; once the order of magnitude grows we can swap in
 * TanStack Virtual the same way the Reader will.
 */

import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Flag,
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
import { libraryDb } from "@/db/library";
import { openProjectDb } from "@/db/dexie";
import {
  countMentionsPerEntry,
  deleteGlossaryEntry,
  listGlossaryEntries,
  updateGlossaryEntry,
} from "@/db/repo/glossary";
import { readInboxDigest } from "@/core/stats";
import {
  GlossaryStatus,
  type GlossaryStatusT,
  SegmentStatus,
} from "@/db/schema";
import { formatStamp } from "@/lib/time";
import { cn } from "@/lib/utils";

export function InboxRoute(): React.JSX.Element {
  const { projectId = "" } = useParams<{ projectId: string }>();

  const project = useLiveQuery(
    async () => libraryDb().projects.get(projectId),
    [projectId],
  );

  const flagged_segments = useLiveQuery(
    async () => {
      if (!projectId) return [];
      const db = openProjectDb(projectId);
      const rows = await db.segments
        .where("status")
        .equals(SegmentStatus.FLAGGED)
        .toArray();
      // Most recent first (high `idx` = late in chapter; we don't have
      // a `flagged_at` column — fall back to event lookup).
      const events = await db.events
        .orderBy("ts")
        .reverse()
        .filter((ev) => ev.kind === "segment.flagged")
        .toArray();
      const last_violations = new Map<
        string,
        Array<{ kind: string; message: string }>
      >();
      for (const ev of events) {
        try {
          const payload = JSON.parse(ev.payload_json) as {
            segment_id: string;
            violations: Array<{ kind: string; message: string }>;
          };
          if (!last_violations.has(payload.segment_id)) {
            last_violations.set(payload.segment_id, payload.violations ?? []);
          }
        } catch {
          // ignore malformed event payloads
        }
      }
      const chapter_ids = [...new Set(rows.map((r) => r.chapter_id))];
      const chapters = await db.chapters.where("id").anyOf(chapter_ids).toArray();
      const chBy = new Map(chapters.map((c) => [c.id, c]));
      return rows.map((r) => ({
        row: r,
        violations: last_violations.get(r.id) ?? [],
        chapter: chBy.get(r.chapter_id) ?? null,
      }));
    },
    [projectId],
    [],
  );

  const proposed_entries = useLiveQuery(
    async () => {
      if (!projectId) return [];
      return listGlossaryEntries(projectId, { status: GlossaryStatus.PROPOSED });
    },
    [projectId],
    [],
  );

  const mention_counts = useLiveQuery<Awaited<
    ReturnType<typeof countMentionsPerEntry>
  >>(
    async () => (projectId ? countMentionsPerEntry(projectId) : {}),
    [projectId],
  );

  const digest = useLiveQuery(
    async () => (projectId ? readInboxDigest(projectId) : null),
    [projectId],
  );

  const onPromoteEntry = React.useCallback(
    async (
      entry_id: string,
      status: GlossaryStatusT,
    ): Promise<void> => {
      try {
        await updateGlossaryEntry(projectId, entry_id, {
          status,
          reason: `inbox: promote to ${status}`,
        });
        toast.success(`Promoted to ${status}.`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Promote failed: ${msg}`);
      }
    },
    [projectId],
  );

  const onDismissEntry = React.useCallback(
    async (entry_id: string): Promise<void> => {
      const ok = window.confirm(
        "Dismiss this proposed entry? It will be deleted entirely.",
      );
      if (!ok) return;
      try {
        await deleteGlossaryEntry(projectId, entry_id);
        toast.success("Entry dismissed.");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Dismiss failed: ${msg}`);
      }
    },
    [projectId],
  );

  const onAcceptFlagged = React.useCallback(
    async (segment_id: string): Promise<void> => {
      try {
        const db = openProjectDb(projectId);
        await db.transaction("rw", db.segments, db.events, async () => {
          await db.segments.update(segment_id, {
            status: SegmentStatus.APPROVED,
          });
          await db.events.add({
            project_id: projectId,
            ts: Date.now(),
            kind: "segment.approved",
            payload_json: JSON.stringify({
              segment_id,
              from_status: SegmentStatus.FLAGGED,
            }),
          });
        });
        toast.success("Accepted as-is.");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Accept failed: ${msg}`);
      }
    },
    [projectId],
  );

  if (project === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading inbox…
      </div>
    );
  }
  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <span>Project not found.</span>
        <Button variant="outline" asChild>
          <Link to="/">
            <ArrowLeft className="size-4" /> Back to projects
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to={`/project/${projectId}`}
            className="flex size-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent"
            aria-label="Back to dashboard"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">
              {project.name} · Inbox
            </h1>
            <p className="text-[11px] text-muted-foreground">
              Curator's queue · flagged segments, proposed entries, and recent
              alerts.
            </p>
          </div>
        </div>
        {digest ? (
          <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <Badge variant="warning">
              {digest.flagged_segments} flagged
            </Badge>
            <Badge variant="proposed">
              {digest.proposed_entries} proposed
            </Badge>
          </div>
        ) : null}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Flag className="size-4 text-warning" /> Flagged segments
            </CardTitle>
            <CardDescription>
              Segments where the validator caught a glossary violation. Fix in
              the Reader or accept as-is.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 p-0">
            {flagged_segments === undefined ? (
              <div className="px-4 py-2 text-sm text-muted-foreground">
                Loading…
              </div>
            ) : flagged_segments.length === 0 ? (
              <div className="px-4 py-2 text-sm text-muted-foreground">
                No flagged segments. The translator is on its best behavior.
              </div>
            ) : (
              <ul className="divide-y border-y">
                {flagged_segments.map((f) => (
                  <li key={f.row.id} className="flex flex-col gap-1.5 px-4 py-2 text-sm">
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="font-mono">
                        Ch {(f.chapter?.spine_idx ?? 0) + 1}
                        {f.chapter?.title ? ` · ${f.chapter.title}` : ""}
                      </span>
                      <span>·</span>
                      <span className="font-mono">seg {f.row.idx + 1}</span>
                      <span>·</span>
                      <span>{f.violations.length} violation
                        {f.violations.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="line-clamp-3 leading-relaxed">
                      {f.row.target_text ?? f.row.source_text}
                    </div>
                    {f.violations.length ? (
                      <ul className="ml-4 list-disc text-[11px] text-warning">
                        {f.violations.map((v, i) => (
                          <li key={i}>{v.message ?? v.kind}</li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="flex gap-1.5 pt-1">
                      <Button asChild size="sm" variant="outline">
                        <Link
                          to={`/project/${projectId}/reader?ch=${f.row.chapter_id}#seg-${f.row.id}`}
                        >
                          Open in Reader
                        </Link>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void onAcceptFlagged(f.row.id)}
                      >
                        <Check className="size-3.5" /> Accept as-is
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Sparkles className="size-4 text-primary" /> Proposed entries
            </CardTitle>
            <CardDescription>
              Auto-proposed glossary candidates from the translator's
              <code className="px-1 font-mono"> new_entities</code> field.
              Promote to confirmed or locked, or dismiss to delete.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {proposed_entries === undefined ? (
              <div className="px-4 py-2 text-sm text-muted-foreground">
                Loading…
              </div>
            ) : proposed_entries.length === 0 ? (
              <div className="px-4 py-2 text-sm text-muted-foreground">
                No proposed entries. Translate more segments to populate this
                list.
              </div>
            ) : (
              <ul className="divide-y border-y">
                {proposed_entries.map((p) => (
                  <li
                    key={p.entry.id}
                    className="flex flex-col gap-1.5 px-4 py-2 text-sm"
                  >
                    <div className="flex items-baseline gap-2">
                      <Badge variant="proposed">{p.entry.type}</Badge>
                      <span className="font-medium">
                        {p.entry.source_term ?? "—"}
                      </span>
                      <span className="text-muted-foreground">→</span>
                      <span>{p.entry.target_term}</span>
                      <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                        {mention_counts?.[p.entry.id]?.mentions ?? 0} mentions
                      </span>
                    </div>
                    {p.entry.notes ? (
                      <div className="text-[11px] text-muted-foreground italic">
                        {p.entry.notes}
                      </div>
                    ) : null}
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        onClick={() =>
                          void onPromoteEntry(p.entry.id, GlossaryStatus.CONFIRMED)
                        }
                      >
                        Confirm
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void onPromoteEntry(p.entry.id, GlossaryStatus.LOCKED)
                        }
                      >
                        Lock
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void onDismissEntry(p.entry.id)}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertCircle className="size-4 text-muted-foreground" /> Recent alerts
            </CardTitle>
            <CardDescription>
              Batch pauses, segment failures, and other inbox-worthy events.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {!digest ? (
              <div className="px-4 py-2 text-sm text-muted-foreground">
                Loading…
              </div>
            ) : digest.alerts.length === 0 ? (
              <div className="px-4 py-2 text-sm text-muted-foreground">
                Nothing to report.
              </div>
            ) : (
              <ul className="divide-y border-y">
                {digest.alerts.map((a) => (
                  <li
                    key={a.id}
                    className={cn(
                      "flex items-center gap-3 px-4 py-2 text-sm",
                      a.kind === "batch_failure" && "text-destructive",
                      a.kind === "batch_paused" && "text-warning",
                    )}
                  >
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {formatStamp(a.ts)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{a.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
