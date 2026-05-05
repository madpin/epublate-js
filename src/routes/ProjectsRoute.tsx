import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowRight,
  BookOpen,
  Clock,
  FolderInput,
  HardDrive,
  Plus,
  Shield,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { importProjectBundle } from "@/core/project_bundle";
import { libraryDb } from "@/db/library";
import { deleteProject } from "@/db/repo/projects";
import { formatRelative } from "@/lib/time";
import { useUiStore } from "@/state/ui";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NewProjectModal } from "@/components/forms/NewProjectModal";
import { CoverThumb } from "@/components/library/CoverThumb";
import { Badge } from "@/components/ui/badge";

export function ProjectsRoute(): React.JSX.Element {
  const setActiveScreen = useUiStore((s) => s.setActiveScreen);
  React.useEffect(() => setActiveScreen("projects"), [setActiveScreen]);

  const navigate = useNavigate();
  const [showNew, setShowNew] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const projects = useLiveQuery(
    () => libraryDb().projects.orderBy("opened_at").reverse().toArray(),
    [],
  );

  const onImportFile = React.useCallback(
    async (file: File) => {
      setImporting(true);
      try {
        const bytes = await file.arrayBuffer();
        const { project_id } = await importProjectBundle(bytes);
        toast.success(`Imported project from “${file.name}”`);
        navigate(`/project/${project_id}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Could not import bundle: ${msg}`);
      } finally {
        setImporting(false);
      }
    },
    [navigate],
  );

  const onDelete = React.useCallback(async (id: string, name: string) => {
    const ok = window.confirm(
      `Delete project “${name}”?\n\nThis removes the database for this project from your browser. Cannot be undone.`,
    );
    if (!ok) return;
    try {
      await deleteProject(id);
      toast.success(`Deleted project “${name}”`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not delete: ${msg}`);
    }
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Translation projects stored locally in your browser.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="gap-2"
            title="Import a previously-exported .epublate-project.zip bundle."
          >
            <FolderInput className="size-4" />{" "}
            {importing ? "Importing…" : "Import bundle"}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
            className="sr-only"
            onChange={(ev) => {
              const file = ev.target.files?.[0];
              ev.target.value = "";
              if (file) void onImportFile(file);
            }}
          />
          <Button onClick={() => setShowNew(true)} className="gap-2">
            <Plus className="size-4" /> New project
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 space-y-4">
        <StorageCard projects_count={projects?.length ?? 0} />
        {projects === undefined ? (
          <SkeletonGrid />
        ) : projects.length === 0 ? (
          <EmptyState onNew={() => setShowNew(true)} />
        ) : (
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((p) => (
              <li key={p.id}>
                <Card className="group relative overflow-hidden transition-colors hover:border-primary/50">
                  <Link
                    to={`/project/${p.id}`}
                    className="block focus:outline-none"
                  >
                    <div className="flex items-start gap-3 px-6 pt-6">
                      <CoverThumb
                        bytes={p.cover_image_bytes ?? null}
                        media_type={p.cover_image_media_type ?? null}
                        name={p.name}
                        className="w-16"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <CardTitle className="min-w-0 truncate text-base">
                            {p.name}
                          </CardTitle>
                          <Badge
                            variant="outline"
                            className="shrink-0 text-[10px]"
                          >
                            {p.source_lang} → {p.target_lang}
                          </Badge>
                        </div>
                        <CardDescription className="mt-1 truncate">
                          {p.source_filename}
                        </CardDescription>
                      </div>
                    </div>

                    <div className="mt-4 flex items-center justify-between border-t px-6 py-3 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <Clock className="size-3" />
                        {formatRelative(p.opened_at)}
                      </span>
                      <span className="inline-flex items-center gap-1 text-foreground/80">
                        Open <ArrowRight className="size-3" />
                      </span>
                    </div>
                  </Link>

                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.preventDefault();
                      void onDelete(p.id, p.name);
                    }}
                    className="absolute right-2 top-2 size-7 opacity-0 transition-opacity group-hover:opacity-100"
                    title="Delete project"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>

      <NewProjectModal open={showNew} onOpenChange={setShowNew} />
    </div>
  );
}

function EmptyState({ onNew }: { onNew(): void }): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <BookOpen className="size-6" />
      </div>
      <h2 className="text-lg font-semibold">No projects yet</h2>
      <p className="mb-6 mt-2 max-w-md text-sm text-muted-foreground">
        Create your first project to start translating an ePub. Everything
        — the book, the glossary, your LLM keys, every prompt and response
        — stays on this device.
      </p>
      <Button onClick={onNew} className="gap-2">
        <Plus className="size-4" /> New project
      </Button>
    </div>
  );
}

function StorageCard({
  projects_count,
}: {
  projects_count: number;
}): React.JSX.Element | null {
  const [estimate, setEstimate] = React.useState<{
    usage: number;
    quota: number;
  } | null>(null);
  const [persisted, setPersisted] = React.useState<boolean | null>(null);
  const [refresh_token, setRefreshToken] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
        setEstimate(null);
        return;
      }
      try {
        const e = await navigator.storage.estimate();
        if (cancelled) return;
        setEstimate({ usage: e.usage ?? 0, quota: e.quota ?? 0 });
      } catch {
        setEstimate(null);
      }
    })();
    void (async () => {
      if (typeof navigator === "undefined" || !navigator.storage?.persisted) {
        setPersisted(null);
        return;
      }
      try {
        const p = await navigator.storage.persisted();
        if (!cancelled) setPersisted(p);
      } catch {
        setPersisted(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh_token, projects_count]);

  if (estimate === null && persisted === null) return null;

  const onPersist = async (): Promise<void> => {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return;
    try {
      const granted = await navigator.storage.persist();
      setPersisted(granted);
      setRefreshToken((n) => n + 1);
      toast[granted ? "success" : "message"](
        granted
          ? "Persistent storage granted."
          : "Persistent storage not granted by the browser. Add the site to bookmarks or install as PWA.",
      );
    } catch {
      // ignored
    }
  };

  const usage_mb =
    estimate !== null ? (estimate.usage / 1024 / 1024).toFixed(1) : null;
  const quota_mb =
    estimate !== null ? (estimate.quota / 1024 / 1024).toFixed(0) : null;
  const pct =
    estimate !== null && estimate.quota > 0
      ? Math.min(100, (estimate.usage / estimate.quota) * 100)
      : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="size-4 text-primary" /> Storage
          </CardTitle>
          {persisted !== null && persisted ? (
            <Badge
              variant="outline"
              className="gap-1 border-emerald-500/50 text-emerald-700 dark:text-emerald-300"
            >
              <Shield className="size-3" /> Persistent
            </Badge>
          ) : persisted !== null ? (
            <Button size="sm" variant="outline" onClick={() => void onPersist()}>
              <Shield className="size-3.5" /> Request persistent storage
            </Button>
          ) : null}
        </div>
        <CardDescription>
          {estimate !== null ? (
            <>
              Using <strong>{usage_mb} MB</strong> of{" "}
              <strong>{quota_mb} MB</strong> available across {projects_count}{" "}
              project{projects_count === 1 ? "" : "s"}.
            </>
          ) : (
            "Browser storage details unavailable."
          )}
        </CardDescription>
        {estimate !== null && estimate.quota > 0 ? (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={pct > 80 ? "h-full bg-destructive" : "h-full bg-primary"}
              style={{ width: `${pct}%` }}
            />
          </div>
        ) : null}
      </CardHeader>
    </Card>
  );
}

function SkeletonGrid(): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="h-32 animate-pulse rounded-lg border bg-card/40"
        />
      ))}
    </div>
  );
}
