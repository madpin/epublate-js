/**
 * Intake runs screen (mirrors `epublate.app.screens.intake_runs`).
 *
 * Lists the helper-LLM book-intake and per-chapter pre-pass runs the
 * project has accumulated, newest first. Each row carries the
 * rolled-up token / cost / cached / failed / proposed counts plus the
 * extracted POV / tense / register / audience and the suggested style
 * profile (if any). Selecting a row reveals its proposed glossary
 * entries.
 */

import * as React from "react";
import { toast } from "sonner";
import { Link, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, FlaskConical, Play, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { IntakeModal } from "@/components/forms/IntakeModal";
import { getProfile, labelForProfile } from "@/core/style";
import { openProjectDb } from "@/db/dexie";
import { libraryDb } from "@/db/library";
import { listGlossaryEntries } from "@/db/repo/glossary";
import { listIntakeRunEntries, listIntakeRuns } from "@/db/repo/intake";
import { applyStyleProfile } from "@/db/repo/projects";
import {
  type IntakeRunRow,
  IntakeRunKind,
  IntakeRunStatus,
} from "@/db/schema";
import { formatCost, formatTokens } from "@/lib/numbers";
import { formatStamp } from "@/lib/time";
import { cn } from "@/lib/utils";

export function IntakeRunsRoute(): React.JSX.Element {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const [modalOpen, setModalOpen] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const project = useLiveQuery(
    async () => libraryDb().projects.get(projectId),
    [projectId],
  );

  const detail = useLiveQuery(
    async () => {
      if (!projectId) return null;
      const db = openProjectDb(projectId);
      return (await db.projects.get(projectId)) ?? null;
    },
    [projectId],
  );

  const runs = useLiveQuery(
    async () => {
      if (!projectId) return [] as IntakeRunRow[];
      return listIntakeRuns(projectId);
    },
    [projectId],
  );

  const chapters = useLiveQuery(
    async () => {
      if (!projectId) return new Map<string, string>();
      const db = openProjectDb(projectId);
      const rows = await db.chapters.toArray();
      return new Map(rows.map((c) => [c.id, c.title || `Chapter ${c.spine_idx + 1}`]));
    },
    [projectId],
  );

  const selected_entries = useLiveQuery(
    async () => {
      if (!projectId || !selectedId) return [];
      const links = await listIntakeRunEntries(projectId, selectedId);
      if (!links.length) return [];
      const all = await listGlossaryEntries(projectId);
      const byId = new Map(all.map((e) => [e.entry.id, e]));
      return links
        .map((l) => byId.get(l.entry_id))
        .filter((e): e is NonNullable<typeof e> => Boolean(e));
    },
    [projectId, selectedId],
  );

  const helper_model = detail?.llm_overrides
    ? safelyExtractHelperModel(detail.llm_overrides)
    : null;

  const totals = React.useMemo(() => {
    if (!runs) return null;
    let cost = 0;
    let prompt = 0;
    let completion = 0;
    let proposed = 0;
    for (const r of runs) {
      cost += r.cost_usd ?? 0;
      prompt += r.prompt_tokens ?? 0;
      completion += r.completion_tokens ?? 0;
      proposed += r.proposed_count ?? 0;
    }
    return { cost, prompt, completion, proposed };
  }, [runs]);

  return (
    <div className="flex h-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Button asChild size="sm" variant="ghost">
          <Link to={`/project/${projectId}`}>
            <ArrowLeft className="size-3.5" /> Dashboard
          </Link>
        </Button>
        <span className="opacity-50">/</span>
        <span>Intake runs</span>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Intake runs</h1>
          <p className="text-sm text-muted-foreground">
            Helper-LLM book intakes + per-chapter pre-passes for{" "}
            <span className="font-medium">{project?.name ?? "…"}</span>.
          </p>
        </div>
        <Button onClick={() => setModalOpen(true)}>
          <FlaskConical className="size-4" /> Run book intake
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="Runs" value={runs ? String(runs.length) : "—"} />
        <SummaryCard
          label="Proposed entries"
          value={totals ? String(totals.proposed) : "—"}
        />
        <SummaryCard
          label="Tokens"
          value={totals ? formatTokens(totals.prompt + totals.completion) : "—"}
        />
        <SummaryCard
          label="Total cost"
          value={totals ? formatCost(totals.cost) : "—"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">History</CardTitle>
          <CardDescription>
            Newest runs first. Click a row to see the entries it
            proposed.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!runs ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              Loading…
            </div>
          ) : runs.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No intake runs yet. Click <em>Run book intake</em> above
              to build a glossary draft from the opening of the book.
            </div>
          ) : (
            <ul className="divide-y border-y">
              {runs.map((r) => {
                const is_selected = selectedId === r.id;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedId(is_selected ? null : r.id)
                      }
                      className={cn(
                        "flex w-full flex-col gap-1.5 px-4 py-3 text-left text-sm transition-colors",
                        is_selected
                          ? "bg-accent"
                          : "hover:bg-accent/50",
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <KindBadge kind={r.kind} />
                        <StatusBadge status={r.status} />
                        <span className="font-mono text-xs text-muted-foreground">
                          {formatStamp(r.started_at)}
                        </span>
                        {r.chapter_id ? (
                          <span className="text-xs text-muted-foreground">
                            ·{" "}
                            {chapters?.get(r.chapter_id) ?? r.chapter_id}
                          </span>
                        ) : null}
                      </div>
                      <div className="grid gap-x-4 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-4">
                        <span>
                          <span className="font-mono">{r.chunks}</span>{" "}
                          chunks
                          {r.cached_chunks > 0 ? (
                            <>
                              {" · "}
                              <span className="font-mono">
                                {r.cached_chunks}
                              </span>{" "}
                              cached
                            </>
                          ) : null}
                        </span>
                        <span>
                          <span className="font-mono">
                            {r.proposed_count}
                          </span>{" "}
                          proposed
                          {r.failed_chunks > 0 ? (
                            <>
                              {" · "}
                              <span className="font-mono text-amber-600">
                                {r.failed_chunks}
                              </span>{" "}
                              failed
                            </>
                          ) : null}
                        </span>
                        <span className="font-mono">
                          {formatCost(r.cost_usd)} ·{" "}
                          {formatTokens(r.prompt_tokens)}+
                          {formatTokens(r.completion_tokens)} tok
                        </span>
                        <span className="truncate">
                          {r.helper_model}
                        </span>
                      </div>
                      {(r.pov ||
                        r.tense ||
                        r.register ||
                        r.audience ||
                        r.suggested_style_profile) && (
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          {r.pov ? (
                            <span className="rounded bg-muted px-1.5 py-0.5">
                              POV: {r.pov}
                            </span>
                          ) : null}
                          {r.tense ? (
                            <span className="rounded bg-muted px-1.5 py-0.5">
                              Tense: {r.tense}
                            </span>
                          ) : null}
                          {r.register ? (
                            <span className="rounded bg-muted px-1.5 py-0.5">
                              Register: {r.register}
                            </span>
                          ) : null}
                          {r.audience ? (
                            <span className="rounded bg-muted px-1.5 py-0.5">
                              Audience: {r.audience}
                            </span>
                          ) : null}
                          {r.suggested_style_profile ? (
                            <span className="flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                              <Sparkles className="size-3" />
                              {r.suggested_style_profile}
                            </span>
                          ) : null}
                        </div>
                      )}
                      {r.error ? (
                        <div className="text-xs text-destructive">
                          {r.error}
                        </div>
                      ) : null}
                    </button>
                    {is_selected ? (
                      <RunDetail
                        project_id={projectId}
                        run={r}
                        active_profile={detail?.style_profile ?? null}
                        entries={selected_entries ?? null}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <IntakeModal
        project_id={projectId}
        open={modalOpen}
        onOpenChange={setModalOpen}
        default_helper_model={helper_model}
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-base font-semibold">{value}</div>
    </div>
  );
}

function KindBadge({ kind }: { kind: string }): React.JSX.Element {
  const label =
    kind === IntakeRunKind.BOOK_INTAKE
      ? "Book intake"
      : kind === IntakeRunKind.CHAPTER_PRE_PASS
        ? "Chapter pre-pass"
        : kind === IntakeRunKind.TONE_SNIFF
          ? "Tone sniff"
          : kind;
  return <Badge variant="secondary">{label}</Badge>;
}

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  if (status === IntakeRunStatus.COMPLETED) {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300">
        Completed
      </Badge>
    );
  }
  if (status === IntakeRunStatus.ABORTED) {
    return (
      <Badge className="bg-destructive/15 text-destructive hover:bg-destructive/20">
        Aborted
      </Badge>
    );
  }
  if (status === IntakeRunStatus.RATE_LIMITED) {
    return <Badge variant="outline">Rate-limited</Badge>;
  }
  if (status === IntakeRunStatus.CANCELLED) {
    return <Badge variant="outline">Cancelled</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

function RunDetail({
  project_id,
  run,
  active_profile,
  entries,
}: {
  project_id: string;
  run: IntakeRunRow;
  active_profile: string | null;
  entries: Awaited<ReturnType<typeof listGlossaryEntries>> | null;
}): React.JSX.Element {
  const [applying, setApplying] = React.useState(false);
  const suggestion = run.suggested_style_profile;
  const can_apply =
    suggestion != null && suggestion !== active_profile;

  const onApply = async (): Promise<void> => {
    if (!suggestion) return;
    setApplying(true);
    try {
      const profile = getProfile(suggestion);
      await applyStyleProfile(project_id, {
        style_profile: suggestion,
        style_guide: profile?.prompt_block ?? null,
        source: `intake:${run.id}`,
      });
      toast.success(
        `Applied helper suggestion: ${labelForProfile(suggestion)}.`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not apply: ${msg}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="border-t bg-muted/30 px-4 py-3 text-sm">
      {suggestion ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300/60 bg-amber-50/80 px-2.5 py-1.5 text-xs dark:border-amber-700/60 dark:bg-amber-950/40">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0">
              <div className="font-medium text-amber-900 dark:text-amber-100">
                Helper suggests:{" "}
                <span className="font-semibold">
                  {labelForProfile(suggestion)}
                </span>
                {!can_apply ? (
                  <span className="ml-1.5 text-[10px] uppercase tracking-wide text-amber-700/80 dark:text-amber-300/80">
                    (already applied)
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          {can_apply ? (
            <Button
              size="sm"
              onClick={() => void onApply()}
              disabled={applying}
              className="h-7 text-[11px]"
            >
              {applying ? "Applying…" : "Apply style"}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Entries proposed
      </div>
      {entries === null ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          This run did not propose any new entries.
        </div>
      ) : (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {entries.map((e) => (
            <li
              key={e.entry.id}
              className="flex items-center gap-2 rounded border bg-background px-2 py-1 text-xs"
            >
              <span className="font-medium">
                {e.entry.source_term ?? "—"}
              </span>
              <span className="text-muted-foreground">
                {e.entry.target_term ?? "(no target)"}
              </span>
              <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                {e.entry.type}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to={`/project/${project_id}/glossary`}>
            <Play className="size-3.5" /> Review in glossary
          </Link>
        </Button>
      </div>
    </div>
  );
}

function safelyExtractHelperModel(json: string): string | null {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (typeof obj.helper_model === "string" && obj.helper_model.trim()) {
      return obj.helper_model.trim();
    }
    return null;
  } catch {
    return null;
  }
}
