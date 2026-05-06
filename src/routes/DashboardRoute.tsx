import * as React from "react";
import { toast } from "sonner";
import { Link, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  Book,
  BookOpen,
  Clock,
  Database,
  Download,
  ListChecks,
  Logs,
  Network,
  Play,
  Plus,
  Settings as SettingsIcon,
  Sparkles,
  Unlink,
} from "lucide-react";

import { AttachLoreModal } from "@/components/forms/AttachLoreModal";
import { BatchModal } from "@/components/forms/BatchModal";
import { StyleEditModal } from "@/components/forms/StyleEditModal";
import { CoverThumb } from "@/components/library/CoverThumb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  buildTranslatedEpub,
  suggestTranslatedFilename,
} from "@/core/export";
import { exportProjectBundle } from "@/core/project_bundle";
import { getProfile, labelForProfile } from "@/core/style";
import { downloadBlob } from "@/lib/download";
import { formatCost } from "@/lib/numbers";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { libraryDb } from "@/db/library";
import { openProjectDb } from "@/db/dexie";
import { findLatestStyleSuggestion } from "@/db/repo/intake";
import { applyStyleProfile } from "@/db/repo/projects";
import { formatStamp } from "@/lib/time";
import {
  AttachedLoreMode,
  type AttachedLoreModeT,
  ChapterStatus,
} from "@/db/schema";
import { readProjectStats } from "@/core/stats";
import { useBatchStore } from "@/state/batch";
import { useRunBookSummary } from "@/hooks/useRunBookSummary";
import {
  detachLoreBook,
  listAttachedLore,
  setAttachedLoreMode,
} from "@/lore/attach";

/**
 * Per-project dashboard. P0 ships the skeleton: project header,
 * progress placeholders, and shortcut tiles. Real progress wiring
 * happens once segmentation lands in P1.
 */
export function DashboardRoute(): React.JSX.Element {
  const { projectId = "" } = useParams<{ projectId: string }>();

  const project = useLiveQuery(
    async () => libraryDb().projects.get(projectId),
    [projectId],
  );

  const detail = useLiveQuery(
    async () => {
      if (!projectId) return null;
      const db = openProjectDb(projectId);
      const row = await db.projects.get(projectId);
      return row ?? null;
    },
    [projectId],
  );

  const chapters = useLiveQuery(
    async () => {
      if (!projectId) return [];
      const db = openProjectDb(projectId);
      return db.chapters
        .where("project_id")
        .equals(projectId)
        .sortBy("spine_idx");
    },
    [projectId],
  );

  const stats = useLiveQuery(
    async () => (projectId ? readProjectStats(projectId) : null),
    [projectId],
  );

  const suggestion = useLiveQuery(
    async () => (projectId ? findLatestStyleSuggestion(projectId) : null),
    [projectId],
  );

  const attached_lore = useLiveQuery(
    async () => (projectId ? listAttachedLore(projectId) : []),
    [projectId],
    [],
  );
  const lore_books_meta = useLiveQuery(
    async () => libraryDb().loreBooks.toArray(),
    [],
    [],
  );

  const active_batch = useBatchStore((s) => s.active);
  const batch_running =
    active_batch !== null &&
    !active_batch.finished &&
    active_batch.project_id === projectId;
  const [batch_open, setBatchOpen] = React.useState(false);
  const [style_open, setStyleOpen] = React.useState(false);
  const [attach_open, setAttachOpen] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);

  const onDownloadEpub = React.useCallback(async () => {
    if (!projectId) return;
    setExporting(true);
    try {
      const [blob, filename] = await Promise.all([
        buildTranslatedEpub(projectId),
        suggestTranslatedFilename(projectId),
      ]);
      downloadBlob(blob, filename);
      toast.success(`Exported ${filename}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not export ePub: ${msg}`);
    } finally {
      setExporting(false);
    }
  }, [projectId]);

  const onDownloadBundle = React.useCallback(async () => {
    if (!projectId) return;
    setExporting(true);
    try {
      const { blob, filename } = await exportProjectBundle(projectId);
      downloadBlob(blob, filename);
      toast.success(`Exported ${filename}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not export bundle: ${msg}`);
    } finally {
      setExporting(false);
    }
  }, [projectId]);

  const attached_ids_set = React.useMemo(
    () => new Set(attached_lore.map((r) => r.lore_path)),
    [attached_lore],
  );

  if (project === undefined || detail === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading project…
      </div>
    );
  }
  if (project === null || detail === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-sm text-muted-foreground">
        <span>Project not found.</span>
        <Button variant="outline" asChild>
          <Link to="/">
            <ArrowLeft className="size-4" /> Back to projects
          </Link>
        </Button>
      </div>
    );
  }

  const project_row = project!;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/"
            className="flex size-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent"
            aria-label="Back to projects"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <CoverThumb
            bytes={project_row.cover_image_bytes ?? null}
            media_type={project_row.cover_image_media_type ?? null}
            name={project_row.name}
            className="w-12"
            variant="tile"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <BookOpen className="size-4 text-primary" />
              <h1 className="truncate text-xl font-semibold tracking-tight">
                {project_row.name}
              </h1>
            </div>
            <p className="truncate text-sm text-muted-foreground">
              {project_row.source_filename} · {project_row.source_lang} →{" "}
              {project_row.target_lang}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-muted-foreground">
            Created {formatStamp(project_row.created_at)}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onDownloadEpub()}
            disabled={exporting || (stats?.translated ?? 0) === 0}
            title={
              (stats?.translated ?? 0) === 0
                ? "Translate at least one segment first"
                : "Build a translated ePub from current segments"
            }
          >
            <Download className="size-3.5" />
            {exporting ? "Exporting…" : "Download ePub"}
          </Button>
          <Button
            size="sm"
            onClick={() => setBatchOpen(true)}
            disabled={batch_running || (stats?.pending ?? 0) === 0}
            title={
              batch_running
                ? "Batch already running"
                : (stats?.pending ?? 0) === 0
                  ? "No pending segments"
                  : "Translate the next batch of pending segments"
            }
          >
            <Play className="size-3.5" />
            {batch_running ? "Translating…" : "Translate batch"}
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Translation</CardTitle>
            <CardDescription>
              Translate segments in the Reader, or kick off a batch run from
              the header. Cache hits are free; failures land in the Inbox.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <Stat
              label="Translated segments"
              value={`${stats?.translated ?? 0} / ${stats?.total_segments ?? 0}`}
            />
            <Stat
              label="Pending"
              value={`${stats?.pending ?? 0}`}
            />
            <Stat
              label="Flagged"
              value={`${stats?.flagged ?? 0}`}
            />
            <Stat
              label="Chapters"
              value={`${chapters?.length ?? 0} parsed`}
            />
            <Stat
              label="LLM spend (lifetime)"
              value={`${formatCost(stats?.cost_usd ?? 0)} · ${formatCacheRate(stats)}`}
            />
            <Stat
              label="Original ePub size"
              value={`${(project_row.source_size_bytes / 1024 / 1024).toFixed(2)} MB`}
            />
            <div className="flex items-center justify-between gap-2 border-t pt-3">
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Style profile
                </div>
                <div className="truncate text-sm font-medium">
                  {labelForProfile(detail.style_profile ?? null)}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setStyleOpen(true)}
              >
                Edit style
              </Button>
            </div>
            <BookSummaryStatusRow
              project_id={projectId}
              book_summary={detail.book_summary ?? null}
            />
            {suggestion &&
            suggestion.suggested_style_profile &&
            suggestion.suggested_style_profile !==
              (detail.style_profile ?? null) ? (
              <SuggestionCallout
                project_id={projectId}
                run_id={suggestion.id}
                profile_id={suggestion.suggested_style_profile}
                register={suggestion.register}
                audience={suggestion.audience}
                started_at={suggestion.started_at}
              />
            ) : null}
          </CardContent>
        </Card>

        <ShortcutCard
          to={`/project/${projectId}/reader`}
          title="Reader"
          icon={BookOpen}
          desc="Side-by-side source / target reader and translator."
        />
        <ShortcutCard
          to={`/project/${projectId}/glossary`}
          title="Glossary"
          icon={Network}
          desc="Lore bible: characters, places, and locked terms."
        />
        <ShortcutCard
          to={`/project/${projectId}/inbox`}
          title="Inbox"
          icon={ListChecks}
          desc="Flagged segments, proposed entries, alerts."
        />
        <ShortcutCard
          to={`/project/${projectId}/settings`}
          title="Project settings"
          icon={SettingsIcon}
          desc="Style, budget, context window, per-project LLM overrides."
        />
        <ShortcutCard
          to={`/project/${projectId}/llm`}
          title="LLM activity"
          icon={Sparkles}
          desc="Prompts, responses, costs, cache hits."
        />
        <ShortcutCard
          to={`/project/${projectId}/intake`}
          title="Intake runs"
          icon={Database}
          desc="Helper-LLM book intake + per-chapter pre-passes."
        />
        <ShortcutCard
          to={`/project/${projectId}/logs`}
          title="Logs"
          icon={Logs}
          desc="Structured event log: batches, intake, segment flags."
        />

        <Card className="lg:col-span-3">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Book className="size-4 text-primary" /> Attached Lore Books
                </CardTitle>
                <CardDescription>
                  Glossary entries from these Lore Books are projected into
                  the translator prompts. Project entries always win on
                  conflicts.
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAttachOpen(true)}
                className="gap-1.5"
              >
                <Plus className="size-3.5" /> Attach
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {attached_lore.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                No Lore Books attached. Attach one from the{" "}
                <Link
                  to="/lore"
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  Lore Books
                </Link>{" "}
                library.
              </div>
            ) : (
              <ul className="space-y-1 rounded-md border">
                {attached_lore.map((row) => {
                  const meta = lore_books_meta.find((b) => b.id === row.lore_path);
                  return (
                    <li
                      key={row.id}
                      className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm odd:bg-card even:bg-card/60"
                    >
                      <Book className="size-3.5 text-primary" />
                      <Link
                        to={`/lore/${row.lore_path}`}
                        className="min-w-0 flex-1 truncate font-medium hover:underline"
                      >
                        {meta?.name ?? row.lore_path}
                      </Link>
                      {meta ? (
                        <Badge
                          variant="outline"
                          className="shrink-0 text-[10px]"
                        >
                          {meta.source_lang} → {meta.target_lang}
                        </Badge>
                      ) : null}
                      <span className="shrink-0 text-xs text-muted-foreground">
                        priority {row.priority}
                      </span>
                      <select
                        value={row.mode}
                        onChange={(e) => {
                          void setAttachedLoreMode(
                            projectId,
                            row.lore_path,
                            e.target.value as AttachedLoreModeT,
                          );
                        }}
                        className="h-7 rounded-md border bg-transparent px-1.5 text-xs"
                      >
                        <option value={AttachedLoreMode.READ_ONLY}>
                          read-only
                        </option>
                        <option value={AttachedLoreMode.WRITABLE}>
                          writable
                        </option>
                      </select>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void (async () => {
                            const ok = window.confirm(
                              `Detach “${meta?.name ?? row.lore_path}”?`,
                            );
                            if (!ok) return;
                            await detachLoreBook(projectId, row.lore_path);
                            toast.success("Lore Book detached.");
                          })()
                        }
                        className="h-7 w-7 p-0"
                        aria-label="Detach"
                      >
                        <Unlink className="size-3.5" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Chapters</CardTitle>
            <CardDescription>
              Spine-order list of every parsed chapter. Click a chapter
              to translate from the Reader once P2 lands.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {chapters === undefined ? (
              <div className="text-sm text-muted-foreground">
                Loading chapters…
              </div>
            ) : chapters.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No chapters yet — intake didn't import anything. Check the
                source ePub.
              </div>
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {chapters.map((ch) => (
                  <li key={ch.id}>
                    <Link
                      to={`/project/${projectId}/reader?ch=${ch.id}`}
                      className="flex items-center gap-3 px-3 py-2 hover:bg-accent/40"
                    >
                      <span className="w-10 shrink-0 font-mono text-[11px] text-muted-foreground">
                        #{ch.spine_idx + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {ch.title ?? ch.href}
                      </span>
                      <span className="rounded-full border px-2 py-0.5 text-[11px] font-mono text-muted-foreground">
                        {ch.status === ChapterStatus.PENDING
                          ? "pending"
                          : ch.status}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <footer className="mt-auto flex flex-wrap items-center gap-2 border-t px-6 py-3 text-xs text-muted-foreground">
        <Clock className="size-3" /> Project DB:{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
          epublate-project-{detail!.id}
        </code>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto gap-1.5"
          onClick={() => void onDownloadBundle()}
          disabled={exporting}
          title="Download a portable .zip with the original ePub, all segments, glossary, and audit logs."
        >
          <Download className="size-3" /> Bundle
        </Button>
      </footer>

      <BatchModal
        project_id={projectId}
        default_budget_usd={detail.budget_usd ?? null}
        pending_count={stats?.pending ?? undefined}
        open={batch_open}
        onOpenChange={setBatchOpen}
      />
      <StyleEditModal
        project_id={projectId}
        open={style_open}
        onOpenChange={setStyleOpen}
        current_profile={detail.style_profile ?? null}
        current_guide={detail.style_guide ?? null}
      />
      <AttachLoreModal
        project_id={projectId}
        open={attach_open}
        onOpenChange={setAttachOpen}
        attached_ids={attached_ids_set}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}

/**
 * Compact "do you have a book summary yet?" status + on-demand
 * regenerate. Mirrors the StyleProfile row above so curators see both
 * project-wide context inputs side-by-side.
 *
 * The button uses the same `useRunBookSummary` hook the Settings card
 * does, so an `intake_run` row + Sonner toast land regardless of where
 * the curator triggered the run from. The deep link to{" "}
 * `/project/<id>/settings#book-summary` is intentional — it lands the
 * curator on the Settings card where they can edit / clear the
 * summary by hand without leaving the Dashboard for a bigger detour.
 */
function BookSummaryStatusRow({
  project_id,
  book_summary,
}: {
  project_id: string;
  book_summary: string | null;
}): React.JSX.Element {
  const { start, running } = useRunBookSummary();
  const has_summary = Boolean(book_summary?.trim());
  const word_count = has_summary
    ? (book_summary as string).trim().split(/\s+/).length
    : 0;
  return (
    <div className="flex items-center justify-between gap-2 border-t pt-3">
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Book summary
        </div>
        <div className="truncate text-sm font-medium">
          {has_summary
            ? `${word_count} word${word_count === 1 ? "" : "s"}`
            : "Not set"}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Button asChild size="sm" variant="ghost">
          <Link to={`/project/${project_id}/settings#book-summary`}>
            Edit
          </Link>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={running}
          onClick={() => void start(project_id)}
          title={
            has_summary
              ? "Regenerate the book summary from the source ePub via the helper LLM."
              : "Generate a 200–400 word book summary from the source ePub via the helper LLM."
          }
        >
          {running
            ? "Generating…"
            : has_summary
              ? "Regenerate"
              : "Generate"}
        </Button>
      </div>
    </div>
  );
}

function ShortcutCard({
  to,
  title,
  icon: Icon,
  desc,
}: {
  to: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  desc: string;
}): React.JSX.Element {
  return (
    <Link
      to={to}
      className="block rounded-lg border bg-card p-4 transition-colors hover:border-primary/50"
    >
      <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4 text-primary" />
        {title}
      </div>
      <p className="text-xs text-muted-foreground">{desc}</p>
    </Link>
  );
}

function formatCacheRate(
  stats: { cache_hits: number; cache_misses: number } | null | undefined,
): string {
  if (!stats) return "0% cache";
  const total = stats.cache_hits + stats.cache_misses;
  if (total === 0) return "no calls yet";
  const pct = (stats.cache_hits / total) * 100;
  return `${pct.toFixed(0)}% cache (${stats.cache_hits}/${total})`;
}

/**
 * Yellow / amber callout that surfaces the helper LLM's
 * `suggested_style_profile` whenever it differs from the project's
 * current style. Mirrors the Python dashboard's "helper suggests
 * tone: …" line, with a one-click apply that goes through
 * {@link applyStyleProfile} so the tone change is audited like every
 * other curator edit.
 */
function SuggestionCallout({
  project_id,
  run_id,
  profile_id,
  register,
  audience,
  started_at,
}: {
  project_id: string;
  run_id: string;
  profile_id: string;
  register: string | null;
  audience: string | null;
  started_at: number;
}): React.JSX.Element {
  const [busy, setBusy] = React.useState(false);
  const profile = getProfile(profile_id);

  const onApply = async (): Promise<void> => {
    setBusy(true);
    try {
      await applyStyleProfile(project_id, {
        style_profile: profile_id,
        style_guide: profile?.prompt_block ?? null,
        source: `intake:${run_id}`,
      });
      toast.success(
        `Applied helper suggestion: ${labelForProfile(profile_id)}.`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not apply suggestion: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs dark:border-amber-700/60 dark:bg-amber-950/40">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0">
          <div className="font-medium text-amber-900 dark:text-amber-100">
            Helper suggests:{" "}
            <span className="font-semibold">{labelForProfile(profile_id)}</span>
          </div>
          <div className="text-[11px] text-amber-800/80 dark:text-amber-200/80">
            {register || audience
              ? `register=${register ?? "—"} · audience=${audience ?? "—"}`
              : "from book intake"}{" "}
            · {formatStamp(started_at)}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <Button
          size="sm"
          variant="outline"
          asChild
          className="h-7 text-[11px]"
        >
          <Link to={`/project/${project_id}/intake`}>Review</Link>
        </Button>
        <Button
          size="sm"
          onClick={() => void onApply()}
          disabled={busy}
          className="h-7 text-[11px]"
        >
          {busy ? "Applying…" : "Apply"}
        </Button>
      </div>
    </div>
  );
}
