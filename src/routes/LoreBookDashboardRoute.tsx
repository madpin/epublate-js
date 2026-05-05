import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  Book,
  Download,
  FolderInput,
  PencilLine,
  Plus,
  Sparkles,
  Trash2,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { openLoreDb } from "@/db/dexie";
import {
  type GlossaryEntryRow,
  type GlossaryStatusT,
  type LoreSourceRow,
  GlossaryStatus,
  LoreSourceKind,
} from "@/db/schema";
import { useFormShortcuts } from "@/hooks/useFormShortcuts";
import { downloadBlob } from "@/lib/download";
import { formatRelative, formatStamp } from "@/lib/time";
import { useUiStore } from "@/state/ui";
import {
  createLoreEntry,
  deleteLoreEntry,
  listLoreEntries,
  updateLoreEntry,
} from "@/lore/glossary";
import {
  exportLoreBundle,
  serializeLoreBundle,
} from "@/lore/io";
import {
  type LoreBookHandle,
  openLoreBook,
  updateLoreMeta,
} from "@/lore/lore";
import { IngestEpubModal } from "@/components/forms/IngestTargetModal";
import { ImportProjectModal } from "@/components/forms/ImportProjectModal";

interface RouteParams {
  loreId: string;
  [key: string]: string | undefined;
}

export function LoreBookDashboardRoute(): React.JSX.Element {
  const { loreId = "" } = useParams<RouteParams>();
  const setActiveScreen = useUiStore((s) => s.setActiveScreen);
  React.useEffect(() => setActiveScreen("lore"), [setActiveScreen]);

  const [handle, setHandle] = React.useState<LoreBookHandle | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [showMetaEdit, setShowMetaEdit] = React.useState(false);
  const [showIngest, setShowIngest] = React.useState(false);
  const [showImport, setShowImport] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const h = await openLoreBook(loreId);
        if (!cancelled) setHandle(h);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loreId]);

  const entries = useLiveQuery(
    () => (loreId ? listLoreEntries(loreId) : Promise.resolve([])),
    [loreId],
  );

  const sources = useLiveQuery(
    async () => {
      if (!loreId) return [];
      const db = openLoreDb(loreId);
      const rows = await db.lore_sources
        .where("project_id")
        .equals(loreId)
        .toArray();
      rows.sort((a, b) => b.ingested_at - a.ingested_at);
      return rows;
    },
    [loreId],
  );

  const onExport = React.useCallback(async () => {
    if (!handle) return;
    try {
      const bundle = await exportLoreBundle(handle.id);
      const blob = new Blob([serializeLoreBundle(bundle)], {
        type: "application/json",
      });
      const safe_name = handle.name.replace(/[^A-Za-z0-9-_]+/g, "_");
      downloadBlob(blob, `${safe_name}.epublate-lore.json`);
      toast.success("Lore Book exported.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Export failed: ${msg}`);
    }
  }, [handle]);

  if (error) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }
  if (!handle) {
    return (
      <div className="p-6">
        <div className="h-32 animate-pulse rounded-lg border bg-card/40" />
      </div>
    );
  }

  const total = entries?.length ?? 0;
  const locked = (entries ?? []).filter(
    (e) => e.entry.status === GlossaryStatus.LOCKED,
  ).length;
  const proposed = (entries ?? []).filter(
    (e) => e.entry.status === GlossaryStatus.PROPOSED,
  ).length;
  const target_only = (entries ?? []).filter(
    (e) => e.entry.source_known === false,
  ).length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/lore"
            className="inline-flex size-7 items-center justify-center rounded-md hover:bg-accent"
            aria-label="Back to Lore Books"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Book className="size-4 text-primary" />
              <h1 className="truncate text-xl font-semibold tracking-tight">
                {handle.name}
              </h1>
              <Badge variant="outline" className="text-[10px]">
                {handle.source_lang} → {handle.target_lang}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {handle.description ?? "No description."} · default proposals:{" "}
              {handle.default_proposal_kind === LoreSourceKind.TARGET
                ? "target-only"
                : "source + target"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => setShowMetaEdit(true)}
            className="gap-2"
          >
            <PencilLine className="size-4" /> Edit
          </Button>
          <Button
            variant="outline"
            onClick={() => setShowIngest(true)}
            className="gap-2"
          >
            <Sparkles className="size-4" /> Ingest ePub
          </Button>
          <Button
            variant="outline"
            onClick={() => setShowImport(true)}
            className="gap-2"
          >
            <FolderInput className="size-4" /> Import project
          </Button>
          <Button
            variant="outline"
            onClick={() => void onExport()}
            className="gap-2"
          >
            <Download className="size-4" /> Export bundle
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto px-6 py-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Entries</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{total}</p>
            <p className="text-xs text-muted-foreground">
              {locked} locked · {proposed} proposed · {target_only} target-only
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Created</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">
              {formatRelative(handle.created_at)}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatStamp(handle.created_at)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Sources ingested</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{sources?.length ?? 0}</p>
            <p className="text-xs text-muted-foreground">
              ePubs that have contributed to this Lore Book
            </p>
          </CardContent>
        </Card>

        <div className="lg:col-span-2">
          <EntriesPanel
            lore_id={handle.id}
            entries={entries ?? []}
            target_only_default={
              handle.default_proposal_kind === LoreSourceKind.TARGET
            }
          />
        </div>
        <SourcesPanel sources={sources ?? []} />
      </div>

      <MetaEditModal
        open={showMetaEdit}
        onOpenChange={setShowMetaEdit}
        handle={handle}
        onSaved={(next) => setHandle(next)}
      />
      <IngestEpubModal
        open={showIngest}
        onOpenChange={setShowIngest}
        lore_id={handle.id}
        source_lang={handle.source_lang}
        target_lang={handle.target_lang}
        default_kind={handle.default_proposal_kind}
      />
      <ImportProjectModal
        open={showImport}
        onOpenChange={setShowImport}
        lore_id={handle.id}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Entries panel                                                       */
/* ------------------------------------------------------------------ */

interface EntriesPanelProps {
  lore_id: string;
  entries: Awaited<ReturnType<typeof listLoreEntries>>;
  target_only_default: boolean;
}

function EntriesPanel(props: EntriesPanelProps): React.JSX.Element {
  const [filter, setFilter] = React.useState("");
  const [showNew, setShowNew] = React.useState(false);

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return props.entries;
    return props.entries.filter((e) => {
      if (e.entry.target_term.toLowerCase().includes(q)) return true;
      if (
        e.entry.source_term &&
        e.entry.source_term.toLowerCase().includes(q)
      ) {
        return true;
      }
      if (e.source_aliases.some((a) => a.toLowerCase().includes(q))) {
        return true;
      }
      if (e.target_aliases.some((a) => a.toLowerCase().includes(q))) {
        return true;
      }
      return false;
    });
  }, [props.entries, filter]);

  const onPromote = React.useCallback(
    async (entry_id: string, status: GlossaryStatusT) => {
      try {
        await updateLoreEntry(props.lore_id, entry_id, {
          status,
          reason: "promoted from dashboard",
        });
        toast.success(`Status set to ${status}.`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Could not update: ${msg}`);
      }
    },
    [props.lore_id],
  );

  const onDelete = React.useCallback(
    async (entry_id: string) => {
      const ok = window.confirm("Delete this entry?");
      if (!ok) return;
      try {
        await deleteLoreEntry(props.lore_id, entry_id);
        toast.success("Entry deleted.");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Could not delete: ${msg}`);
      }
    },
    [props.lore_id],
  );

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-sm">Glossary entries</CardTitle>
            <CardDescription>
              {props.entries.length} entries in this Lore Book
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              className="h-8 w-44"
            />
            <Button size="sm" onClick={() => setShowNew(true)} className="gap-1.5">
              <Plus className="size-3.5" /> New entry
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
            {props.entries.length === 0
              ? "No entries yet. Create one or ingest an ePub to seed proposals."
              : "No entries match this filter."}
          </div>
        ) : (
          <ul className="divide-y rounded-md border">
            {filtered.map((e) => (
              <li
                key={e.entry.id}
                className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
              >
                <Badge
                  variant="outline"
                  className="shrink-0 text-[10px] uppercase tracking-wide"
                >
                  {e.entry.type}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {e.entry.target_term}
                    {e.entry.source_term ? (
                      <span className="ml-2 text-muted-foreground">
                        ← {e.entry.source_term}
                      </span>
                    ) : (
                      <span className="ml-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                        target-only
                      </span>
                    )}
                  </div>
                  {e.target_aliases.length || e.source_aliases.length ? (
                    <div className="truncate text-xs text-muted-foreground">
                      aliases: {[...e.source_aliases, ...e.target_aliases].join(" · ")}
                    </div>
                  ) : null}
                </div>
                <Badge
                  variant={
                    e.entry.status === GlossaryStatus.LOCKED
                      ? "locked"
                      : e.entry.status === GlossaryStatus.CONFIRMED
                        ? "confirmed"
                        : "proposed"
                  }
                  className="shrink-0 text-[10px] capitalize"
                >
                  {e.entry.status}
                </Badge>
                <div className="ml-1 flex shrink-0 gap-1">
                  {e.entry.status !== GlossaryStatus.LOCKED ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void onPromote(e.entry.id, GlossaryStatus.LOCKED)
                      }
                      className="h-7 text-[11px]"
                    >
                      Lock
                    </Button>
                  ) : null}
                  {e.entry.status === GlossaryStatus.PROPOSED ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void onPromote(e.entry.id, GlossaryStatus.CONFIRMED)
                      }
                      className="h-7 text-[11px]"
                    >
                      Confirm
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void onDelete(e.entry.id)}
                    className="h-7 w-7 p-0"
                    aria-label="Delete"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <NewLoreEntryModal
        open={showNew}
        onOpenChange={setShowNew}
        lore_id={props.lore_id}
        target_only_default={props.target_only_default}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Sources panel                                                       */
/* ------------------------------------------------------------------ */

function SourcesPanel({
  sources,
}: {
  sources: readonly LoreSourceRow[];
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Ingested sources</CardTitle>
        <CardDescription>
          Audit trail of ePubs that contributed to this Lore Book.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sources.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-8 text-center text-xs text-muted-foreground">
            No ingest runs yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {sources.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{s.epub_path}</div>
                  <div className="text-muted-foreground">
                    {formatStamp(s.ingested_at)} · {s.entries_added} entries
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="outline" className="text-[10px] capitalize">
                    {s.kind}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] capitalize">
                    {s.status}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Meta edit modal                                                     */
/* ------------------------------------------------------------------ */

interface MetaEditModalProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  handle: LoreBookHandle;
  onSaved(handle: LoreBookHandle): void;
}

function MetaEditModal(props: MetaEditModalProps): React.JSX.Element {
  const [name, setName] = React.useState(props.handle.name);
  const [description, setDescription] = React.useState(
    props.handle.description ?? "",
  );
  const [busy, setBusy] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement | null>(null);
  useFormShortcuts(formRef, props.open);

  React.useEffect(() => {
    if (props.open) {
      setName(props.handle.name);
      setDescription(props.handle.description ?? "");
    }
  }, [props.open, props.handle]);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setBusy(true);
    try {
      const next = await updateLoreMeta(props.handle.id, {
        name: name.trim(),
        description: description.trim() || null,
      });
      props.onSaved(next);
      props.onOpenChange(false);
      toast.success("Lore Book updated.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not update: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Lore Book</DialogTitle>
          <DialogDescription>
            Rename or update the description. Language pair and proposal kind
            are fixed for now.
          </DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          onSubmit={(e) => void onSubmit(e)}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="meta-name">Name</Label>
            <Input
              id="meta-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meta-desc">Description</Label>
            <Textarea
              id="meta-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              disabled={busy}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => props.onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* New entry modal                                                     */
/* ------------------------------------------------------------------ */

interface NewLoreEntryModalProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  lore_id: string;
  target_only_default: boolean;
}

function NewLoreEntryModal(props: NewLoreEntryModalProps): React.JSX.Element {
  const [target, setTarget] = React.useState("");
  const [source, setSource] = React.useState("");
  const [target_only, setTargetOnly] = React.useState(props.target_only_default);
  const [type, setType] = React.useState<GlossaryEntryRow["type"]>("term");
  const [busy, setBusy] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement | null>(null);
  useFormShortcuts(formRef, props.open);

  React.useEffect(() => {
    if (props.open) {
      setTarget("");
      setSource("");
      setTargetOnly(props.target_only_default);
      setType("term");
    }
  }, [props.open, props.target_only_default]);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!target.trim()) {
      toast.error("Target term is required");
      return;
    }
    if (!target_only && !source.trim()) {
      toast.error("Source term is required (or check target-only)");
      return;
    }
    setBusy(true);
    try {
      await createLoreEntry(props.lore_id, {
        source_term: target_only ? null : source.trim(),
        target_term: target.trim(),
        type,
        status: GlossaryStatus.PROPOSED,
        source_known: !target_only,
      });
      props.onOpenChange(false);
      toast.success("Entry added.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not add entry: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New entry</DialogTitle>
          <DialogDescription>
            Add a glossary entry to this Lore Book.
          </DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          onSubmit={(e) => void onSubmit(e)}
          className="space-y-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Target term</Label>
              <Input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                disabled={busy}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label>Source term</Label>
              <Input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                disabled={busy || target_only}
                placeholder={target_only ? "(target-only)" : ""}
              />
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <input
              id="target-only"
              type="checkbox"
              checked={target_only}
              onChange={(e) => setTargetOnly(e.target.checked)}
              disabled={busy}
            />
            <Label htmlFor="target-only" className="text-xs">
              Target-only entry (no source spelling)
            </Label>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="type">Type</Label>
            <select
              id="type"
              value={type}
              onChange={(e) =>
                setType(e.target.value as GlossaryEntryRow["type"])
              }
              disabled={busy}
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
            >
              {[
                "character",
                "place",
                "organization",
                "event",
                "item",
                "date_or_time",
                "phrase",
                "term",
                "other",
              ].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => props.onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
