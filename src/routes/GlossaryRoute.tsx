/**
 * Glossary screen — the lore bible (mirrors `epublate.app.screens.glossary`).
 *
 * Three-column layout:
 *
 * 1. **Toolbar.** New entry, JSON / CSV import-export, cleanup
 *    duplicates, status filter, free-text filter.
 * 2. **Entries table.** TanStack Table v8 over the project's glossary.
 *    Sortable + filterable. Each row shows status, type, source +
 *    target terms, and "Uses" — the per-entry mention count from
 *    `entity_mentions`. Clicking a row selects it and reveals the
 *    detail pane on the right.
 * 3. **Detail pane.** Source/target aliases, notes, and a revision
 *    log. Buttons: Edit, Delete, Show occurrences.
 *
 * The route reads exclusively from the per-project Dexie DB via
 * `useLiveQuery`, so any pipeline run (which writes mentions /
 * revisions) updates the table without manual refresh.
 */

import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  ExternalLink,
  FileJson,
  FileText,
  Filter,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { libraryDb } from "@/db/library";
import {
  countMentionsPerEntry,
  deleteGlossaryEntry,
  listGlossaryEntries,
  listGlossaryRevisions,
  type MentionCounts,
} from "@/db/repo/glossary";
import { findIntakeRunForEntry } from "@/db/repo/intake";
import {
  GlossaryStatus,
  type GlossaryStatusT,
  IntakeRunKind,
} from "@/db/schema";
import {
  exportCsv,
  exportJson,
  importJson,
  parseCsv,
  GLOSSARY_FORMAT_VERSION,
} from "@/glossary/io";
import type { GlossaryEntryWithAliases } from "@/glossary/models";
import { EntryEditModal } from "@/components/glossary/EntryEditModal";
import { OccurrencesModal } from "@/components/glossary/OccurrencesModal";
import { MergeDuplicatesModal } from "@/components/glossary/MergeDuplicatesModal";
import { formatStamp } from "@/lib/time";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | GlossaryStatusT;

const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  all: "All",
  proposed: "Proposed",
  confirmed: "Confirmed",
  locked: "Locked",
};

function statusBadgeVariant(status: string): "locked" | "confirmed" | "proposed" {
  if (status === GlossaryStatus.LOCKED) return "locked";
  if (status === GlossaryStatus.CONFIRMED) return "confirmed";
  return "proposed";
}

export function GlossaryRoute(): React.JSX.Element {
  const { projectId = "" } = useParams<{ projectId: string }>();

  const project = useLiveQuery(
    async () => libraryDb().projects.get(projectId),
    [projectId],
  );

  const all_entries = useLiveQuery<GlossaryEntryWithAliases[] | undefined>(
    async () => (projectId ? listGlossaryEntries(projectId) : undefined),
    [projectId],
  );

  const mention_counts = useLiveQuery<Record<string, MentionCounts>>(
    async () =>
      projectId ? countMentionsPerEntry(projectId) : {},
    [projectId],
  );

  const [filter_status, setFilterStatus] = React.useState<StatusFilter>("all");
  const [filter_text, setFilterText] = React.useState("");
  const [selected_id, setSelectedId] = React.useState<string | null>(null);
  const [edit_modal_open, setEditModalOpen] = React.useState(false);
  const [edit_target, setEditTarget] = React.useState<
    GlossaryEntryWithAliases | null
  >(null);
  const [occurrences_open, setOccurrencesOpen] = React.useState(false);
  const [merge_open, setMergeOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const filtered = React.useMemo(() => {
    if (!all_entries) return [];
    const needle = filter_text.trim().toLowerCase();
    return all_entries.filter((ent) => {
      if (filter_status !== "all" && ent.entry.status !== filter_status) {
        return false;
      }
      if (!needle) return true;
      const haystack = [
        ent.entry.source_term ?? "",
        ent.entry.target_term,
        ent.entry.notes ?? "",
        ...ent.source_aliases,
        ...ent.target_aliases,
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [all_entries, filter_status, filter_text]);

  React.useEffect(() => {
    if (!filtered.length) {
      if (selected_id !== null) setSelectedId(null);
      return;
    }
    if (!filtered.some((e) => e.entry.id === selected_id)) {
      setSelectedId(filtered[0]!.entry.id);
    }
  }, [filtered, selected_id]);

  const selected =
    selected_id != null
      ? all_entries?.find((e) => e.entry.id === selected_id) ?? null
      : null;

  const status_counts = React.useMemo<Record<StatusFilter, number>>(() => {
    const counts: Record<StatusFilter, number> = {
      all: 0,
      proposed: 0,
      confirmed: 0,
      locked: 0,
    };
    for (const e of all_entries ?? []) {
      counts.all += 1;
      counts[e.entry.status] += 1;
    }
    return counts;
  }, [all_entries]);

  const onNew = (): void => {
    setEditTarget(null);
    setEditModalOpen(true);
  };

  const onEdit = (ent: GlossaryEntryWithAliases): void => {
    setEditTarget(ent);
    setEditModalOpen(true);
  };

  const onDelete = async (ent: GlossaryEntryWithAliases): Promise<void> => {
    const ok = window.confirm(
      `Delete entry "${ent.entry.source_term ?? ent.entry.target_term}"?\n\nAliases, revisions, and recorded mentions will be removed too.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await deleteGlossaryEntry(projectId, ent.entry.id);
      toast.success("Entry deleted.");
      setSelectedId(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Delete failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const onExportJson = async (): Promise<void> => {
    setBusy(true);
    try {
      const payload = await exportJson(projectId);
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      triggerDownload(
        blob,
        `${project?.name ?? "glossary"}.glossary.json`,
      );
      toast.success(`Exported ${payload.entries.length} entries.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Export failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const onExportCsv = async (): Promise<void> => {
    if (!all_entries) return;
    setBusy(true);
    try {
      const csv = exportCsv(all_entries);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      triggerDownload(blob, `${project?.name ?? "glossary"}.glossary.csv`);
      toast.success(`Exported ${all_entries.length} entries.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Export failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const onImport = async (file: File): Promise<void> => {
    setBusy(true);
    try {
      const text = await file.text();
      const isCsv =
        file.name.toLowerCase().endsWith(".csv") ||
        file.type.toLowerCase().includes("csv");
      const payload = isCsv ? parseCsv(text) : JSON.parse(text);
      const summary = await importJson(projectId, payload, {
        conflict: "skip",
      });
      toast.success(
        `Imported · ${summary.created} created · ${summary.updated} updated · ${summary.skipped} skipped.`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Import failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const file_input_ref = React.useRef<HTMLInputElement | null>(null);

  if (project === undefined || all_entries === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading glossary…
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
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to={`/project/${projectId}`}
            className="flex size-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent"
            aria-label="Back to dashboard"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">
              {project.name} · Glossary
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {project.source_lang} → {project.target_lang} ·{" "}
              {status_counts.all} entries · {status_counts.proposed} proposed ·{" "}
              {status_counts.confirmed} confirmed · {status_counts.locked} locked
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onNew}>
            <Plus className="size-4" /> New entry
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => file_input_ref.current?.click()}
            disabled={busy}
          >
            <Upload className="size-4" /> Import
          </Button>
          <input
            ref={file_input_ref}
            type="file"
            accept=".json,.csv,application/json,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onImport(file);
              e.target.value = "";
            }}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onExportJson()}
            disabled={busy || !all_entries.length}
          >
            <FileJson className="size-4" /> JSON
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onExportCsv()}
            disabled={busy || !all_entries.length}
          >
            <FileText className="size-4" /> CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setMergeOpen(true)}
            disabled={busy || !all_entries.length}
          >
            <RefreshCw className="size-4" /> Cleanup duplicates
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_22rem]">
        <section className="flex min-h-0 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
            <Filter className="size-3.5 text-muted-foreground" />
            <div className="flex items-center gap-1">
              {(Object.keys(STATUS_FILTER_LABELS) as StatusFilter[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setFilterStatus(s)}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-xs",
                    filter_status === s
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-transparent hover:bg-accent/40",
                  )}
                >
                  {STATUS_FILTER_LABELS[s]}{" "}
                  <span className="text-muted-foreground">
                    ({status_counts[s]})
                  </span>
                </button>
              ))}
            </div>
            <Input
              value={filter_text}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filter (term, alias, notes)…"
              className="ml-auto h-8 w-64"
            />
          </div>

          <GlossaryTable
            entries={filtered}
            mention_counts={mention_counts ?? {}}
            selected_id={selected_id}
            onSelect={setSelectedId}
          />
        </section>

        <DetailPane
          project_id={projectId}
          entry={selected}
          onEdit={onEdit}
          onDelete={onDelete}
          onShowOccurrences={() => setOccurrencesOpen(true)}
          mention_count={
            selected
              ? mention_counts?.[selected.entry.id]?.mentions ?? 0
              : 0
          }
        />
      </div>

      <footer className="flex items-center gap-3 border-t px-4 py-2 text-[11px] text-muted-foreground">
        <span>schema v{GLOSSARY_FORMAT_VERSION}</span>
        <span>·</span>
        <span>everything in this glossary lives in your browser only</span>
      </footer>

      <EntryEditModal
        project_id={projectId}
        entry={edit_target}
        open={edit_modal_open}
        onOpenChange={setEditModalOpen}
        onSaved={(id) => setSelectedId(id)}
      />
      <OccurrencesModal
        project_id={projectId}
        entry={selected}
        open={occurrences_open}
        onOpenChange={setOccurrencesOpen}
      />
      <MergeDuplicatesModal
        project_id={projectId}
        open={merge_open}
        onOpenChange={setMergeOpen}
      />
    </div>
  );
}

interface GlossaryTableProps {
  entries: GlossaryEntryWithAliases[];
  mention_counts: Record<string, MentionCounts>;
  selected_id: string | null;
  onSelect(id: string): void;
}

type SortKey =
  | "status"
  | "type"
  | "source"
  | "target"
  | "uses"
  | "updated";
type SortDirection = "asc" | "desc";

interface SortState {
  key: SortKey;
  direction: SortDirection;
}

const STATUS_ORDER: Record<string, number> = {
  proposed: 0,
  confirmed: 1,
  locked: 2,
};

function compareEntries(
  a: GlossaryEntryWithAliases,
  b: GlossaryEntryWithAliases,
  key: SortKey,
  counts: Record<string, MentionCounts>,
): number {
  switch (key) {
    case "status": {
      const av = STATUS_ORDER[a.entry.status] ?? 99;
      const bv = STATUS_ORDER[b.entry.status] ?? 99;
      return av - bv;
    }
    case "type":
      return (a.entry.type ?? "").localeCompare(b.entry.type ?? "");
    case "source": {
      const av = (a.entry.source_term ?? "").toLowerCase();
      const bv = (b.entry.source_term ?? "").toLowerCase();
      return av.localeCompare(bv);
    }
    case "target":
      return (a.entry.target_term ?? "")
        .toLowerCase()
        .localeCompare((b.entry.target_term ?? "").toLowerCase());
    case "uses": {
      const am = counts[a.entry.id]?.mentions ?? 0;
      const bm = counts[b.entry.id]?.mentions ?? 0;
      return am - bm;
    }
    case "updated":
      return (a.entry.updated_at ?? 0) - (b.entry.updated_at ?? 0);
    default:
      return 0;
  }
}

function GlossaryTable({
  entries,
  mention_counts,
  selected_id,
  onSelect,
}: GlossaryTableProps): React.JSX.Element {
  const [sort, setSort] = React.useState<SortState>({
    key: "updated",
    direction: "desc",
  });

  const sorted = React.useMemo(() => {
    const arr = [...entries];
    arr.sort((a, b) => {
      const cmp = compareEntries(a, b, sort.key, mention_counts);
      return sort.direction === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [entries, sort, mention_counts]);

  const onHeader = React.useCallback((key: SortKey): void => {
    setSort((prev) => {
      if (prev.key !== key) {
        // Numeric / date columns default to descending so the highest
        // value lands on top — that's almost always what the curator
        // wants on a first click ("show me the most-used entries").
        const default_dir: SortDirection =
          key === "uses" || key === "updated" ? "desc" : "asc";
        return { key, direction: default_dir };
      }
      return {
        key,
        direction: prev.direction === "asc" ? "desc" : "asc",
      };
    });
  }, []);

  if (sorted.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No entries match your filters.
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-card text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <tr className="border-b">
            <SortHeader
              label="Status"
              k="status"
              sort={sort}
              onSort={onHeader}
              className="w-24"
              align="left"
            />
            <SortHeader
              label="Type"
              k="type"
              sort={sort}
              onSort={onHeader}
              className="w-24"
              align="left"
            />
            <SortHeader
              label="Source"
              k="source"
              sort={sort}
              onSort={onHeader}
              align="left"
            />
            <SortHeader
              label="Target"
              k="target"
              sort={sort}
              onSort={onHeader}
              align="left"
            />
            <SortHeader
              label="Uses"
              k="uses"
              sort={sort}
              onSort={onHeader}
              className="w-16"
              align="right"
            />
            <SortHeader
              label="Updated"
              k="updated"
              sort={sort}
              onSort={onHeader}
              className="w-32"
              align="right"
            />
          </tr>
        </thead>
        <tbody>
          {sorted.map((ent) => {
            const counts = mention_counts[ent.entry.id];
            return (
              <tr
                key={ent.entry.id}
                onClick={() => onSelect(ent.entry.id)}
                className={cn(
                  "cursor-pointer border-b transition-colors hover:bg-accent/30",
                  ent.entry.id === selected_id && "bg-accent/40",
                )}
              >
                <td className="px-3 py-2">
                  <Badge variant={statusBadgeVariant(ent.entry.status)}>
                    {ent.entry.status}
                  </Badge>
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                  {ent.entry.type}
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium">
                    {ent.entry.source_term ?? (
                      <span className="italic text-muted-foreground">
                        target-only
                      </span>
                    )}
                  </div>
                  {ent.source_aliases.length ? (
                    <div className="text-[11px] text-muted-foreground">
                      aka {ent.source_aliases.join(", ")}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium">{ent.entry.target_term}</div>
                  {ent.target_aliases.length ? (
                    <div className="text-[11px] text-muted-foreground">
                      aka {ent.target_aliases.join(", ")}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[12px]">
                  {counts ? (
                    <span title={`${counts.segments} segment(s)`}>
                      {counts.mentions}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[11px] text-muted-foreground">
                  {ent.entry.updated_at
                    ? formatStamp(ent.entry.updated_at)
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface SortHeaderProps {
  label: string;
  k: SortKey;
  sort: SortState;
  onSort(k: SortKey): void;
  className?: string;
  align?: "left" | "right";
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  className,
  align = "left",
}: SortHeaderProps): React.JSX.Element {
  const active = sort.key === k;
  const Icon = !active
    ? ChevronsUpDown
    : sort.direction === "asc"
      ? ChevronUp
      : ChevronDown;
  return (
    <th
      className={cn(
        "px-3 py-2 text-left",
        align === "right" && "text-right",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          align === "right" && "ml-auto",
          active ? "text-foreground" : "",
        )}
      >
        <span>{label}</span>
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            active ? "opacity-100" : "opacity-50",
          )}
        />
      </button>
    </th>
  );
}

interface DetailPaneProps {
  project_id: string;
  entry: GlossaryEntryWithAliases | null;
  onEdit(ent: GlossaryEntryWithAliases): void;
  onDelete(ent: GlossaryEntryWithAliases): void;
  onShowOccurrences(): void;
  mention_count: number;
}

function DetailPane({
  project_id,
  entry,
  onEdit,
  onDelete,
  onShowOccurrences,
  mention_count,
}: DetailPaneProps): React.JSX.Element {
  const revisions = useLiveQuery(
    async () => {
      if (!entry) return [];
      return listGlossaryRevisions(project_id, entry.entry.id);
    },
    [project_id, entry?.entry.id],
  );

  const intake_run = useLiveQuery(
    async () => {
      if (!entry) return null;
      return findIntakeRunForEntry(project_id, entry.entry.id);
    },
    [project_id, entry?.entry.id],
  );

  if (!entry) {
    return (
      <aside className="flex min-h-0 flex-col items-center justify-center border-l bg-card/30 p-6 text-center text-sm text-muted-foreground">
        Select an entry to see its detail, aliases, and revision log.
      </aside>
    );
  }
  const e = entry.entry;
  return (
    <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-l bg-card/30 p-4">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="break-words text-base font-semibold">
            {e.source_term ?? (
              <em className="text-muted-foreground">target-only</em>
            )}
          </h2>
          <Badge variant={statusBadgeVariant(e.status)}>{e.status}</Badge>
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          → <strong className="text-foreground">{e.target_term}</strong>
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {e.type} · {e.gender ?? "(no gender)"} · created{" "}
          {formatStamp(e.created_at)}
          {e.updated_at !== e.created_at
            ? ` · updated ${formatStamp(e.updated_at)}`
            : ""}
        </div>
        {intake_run ? (
          <div className="mt-1 text-[11px] text-muted-foreground">
            Introduced by{" "}
            <Link
              to={`/project/${project_id}/intake`}
              className="text-primary hover:underline"
            >
              {intake_run.kind === IntakeRunKind.BOOK_INTAKE
                ? "book intake"
                : "chapter pre-pass"}{" "}
              · {formatStamp(intake_run.started_at)}
            </Link>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onEdit(entry)}>
          Edit
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onDelete(entry)}
        >
          <Trash2 className="size-3.5" /> Delete
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onShowOccurrences}
          disabled={mention_count === 0}
        >
          <ExternalLink className="size-3.5" /> Show occurrences ({mention_count})
        </Button>
      </div>

      {entry.source_aliases.length || entry.target_aliases.length ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
              Aliases
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {entry.source_aliases.length ? (
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Source
                </div>
                <ul className="ml-4 list-disc">
                  {entry.source_aliases.map((a) => (
                    <li key={`s-${a}`}>{a}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {entry.target_aliases.length ? (
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Target
                </div>
                <ul className="ml-4 list-disc">
                  {entry.target_aliases.map((a) => (
                    <li key={`t-${a}`}>{a}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {e.notes ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
              Notes
            </CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm leading-relaxed">
            {e.notes}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
            Revisions
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs">
          {revisions === undefined ? (
            <div className="text-muted-foreground">Loading…</div>
          ) : revisions.length === 0 ? (
            <div className="text-muted-foreground">
              No revisions yet — edits to the target term or status will appear
              here.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {revisions.map((rev) => (
                <li
                  key={rev.id}
                  className="rounded border border-dashed bg-card/40 px-2 py-1.5"
                >
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {formatStamp(rev.created_at)}
                  </div>
                  <div>
                    {rev.prev_target_term !== rev.new_target_term ? (
                      <>
                        <span className="line-through">
                          {rev.prev_target_term ?? "—"}
                        </span>{" "}
                        → <strong>{rev.new_target_term ?? "—"}</strong>
                      </>
                    ) : (
                      <span className="text-muted-foreground italic">
                        target unchanged
                      </span>
                    )}
                  </div>
                  {rev.reason ? (
                    <div className="text-muted-foreground italic">
                      {rev.reason}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </aside>
  );
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
