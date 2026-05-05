import * as React from "react";
import { Link } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowRight,
  Book,
  Clock,
  FileJson,
  Plus,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";

import { libraryDb } from "@/db/library";
import { LoreSourceKind } from "@/db/schema";
import { formatRelative } from "@/lib/time";
import { useUiStore } from "@/state/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { NewLoreBookModal } from "@/components/forms/NewLoreBookModal";
import { deleteLoreBook } from "@/lore/lore";
import { importLoreBundle, parseLoreBundle } from "@/lore/io";

export function LoreBooksRoute(): React.JSX.Element {
  const setActiveScreen = useUiStore((s) => s.setActiveScreen);
  React.useEffect(() => setActiveScreen("lore"), [setActiveScreen]);

  const [showNew, setShowNew] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const books = useLiveQuery(
    () => libraryDb().loreBooks.orderBy("opened_at").reverse().toArray(),
    [],
  );

  const onDelete = React.useCallback(
    async (id: string, name: string) => {
      const ok = window.confirm(
        `Delete Lore Book “${name}”?\n\nThis removes the database for this Lore Book from your browser. Cannot be undone.`,
      );
      if (!ok) return;
      try {
        await deleteLoreBook(id);
        toast.success(`Deleted Lore Book “${name}”`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Could not delete: ${msg}`);
      }
    },
    [],
  );

  const onImport = React.useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const bundle = parseLoreBundle(text);
        const result = await importLoreBundle(bundle);
        toast.success(
          `Imported Lore Book — ${result.entries_count} entries.`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Import failed: ${msg}`);
      }
    },
    [],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Lore Books</h1>
          <p className="text-sm text-muted-foreground">
            Portable glossaries you can attach to many translation projects.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onImport(file);
              e.target.value = "";
            }}
          />
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            className="gap-2"
          >
            <UploadCloud className="size-4" /> Import bundle
          </Button>
          <Button onClick={() => setShowNew(true)} className="gap-2">
            <Plus className="size-4" /> New Lore Book
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 space-y-4">
        {books === undefined ? (
          <SkeletonGrid />
        ) : books.length === 0 ? (
          <EmptyState onNew={() => setShowNew(true)} />
        ) : (
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {books.map((b) => (
              <li key={b.id}>
                <Card className="group relative overflow-hidden transition-colors hover:border-primary/50">
                  <Link
                    to={`/lore/${b.id}`}
                    className="block focus:outline-none"
                  >
                    <CardHeader className="pb-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <Book className="size-4 shrink-0 text-primary" />
                          <CardTitle className="truncate text-base">
                            {b.name}
                          </CardTitle>
                        </div>
                        <Badge
                          variant="outline"
                          className="shrink-0 text-[10px]"
                        >
                          {b.source_lang} → {b.target_lang}
                        </Badge>
                      </div>
                      <CardDescription className="line-clamp-2">
                        {b.description ??
                          (b.default_proposal_kind === LoreSourceKind.TARGET
                            ? "Target-only proposals"
                            : "Source + target proposals")}
                      </CardDescription>
                    </CardHeader>

                    <div className="flex items-center justify-between gap-3 border-t px-6 py-3 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <Clock className="size-3" />
                        {formatRelative(b.opened_at)}
                      </span>
                      <span className="inline-flex items-center gap-2">
                        <span title="Total entries">
                          {b.entries_total} entries
                        </span>
                        {b.entries_locked ? (
                          <span title="Locked entries">
                            ({b.entries_locked} locked)
                          </span>
                        ) : null}
                        <ArrowRight className="size-3 text-foreground/80" />
                      </span>
                    </div>
                  </Link>

                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.preventDefault();
                      void onDelete(b.id, b.name);
                    }}
                    className="absolute right-2 top-2 size-7 opacity-0 transition-opacity group-hover:opacity-100"
                    title="Delete Lore Book"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>

      <NewLoreBookModal open={showNew} onOpenChange={setShowNew} />
    </div>
  );
}

function EmptyState({ onNew }: { onNew(): void }): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Book className="size-6" />
      </div>
      <h2 className="text-lg font-semibold">No Lore Books yet</h2>
      <p className="mb-6 mt-2 max-w-md text-sm text-muted-foreground">
        Lore Books pin canonical translations across multiple projects. Create
        one for a series, attach it to projects, and the translator pipeline
        will keep those terms consistent.
      </p>
      <div className="flex gap-2">
        <Button onClick={onNew} className="gap-2">
          <Plus className="size-4" /> New Lore Book
        </Button>
        <Button variant="outline" className="gap-2" disabled>
          <FileJson className="size-4" /> Import bundle
        </Button>
      </div>
    </div>
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
