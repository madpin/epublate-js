import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Book } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { libraryDb } from "@/db/library";
import { AttachedLoreMode, type AttachedLoreModeT } from "@/db/schema";
import { useFormShortcuts } from "@/hooks/useFormShortcuts";
import {
  attachLoreBook,
  DEFAULT_RETRIEVAL_MIN_SIMILARITY,
  DEFAULT_RETRIEVAL_TOP_K,
} from "@/lore/attach";

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  project_id: string;
  /** Lore book ids already attached — they're rendered disabled. */
  attached_ids: ReadonlySet<string>;
}

export function AttachLoreModal({
  open,
  onOpenChange,
  project_id,
  attached_ids,
}: Props): React.JSX.Element {
  const books = useLiveQuery(
    () => libraryDb().loreBooks.orderBy("name").toArray(),
    [],
  );

  const [selected, setSelected] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<AttachedLoreModeT>(
    AttachedLoreMode.READ_ONLY,
  );
  const [retrievalEnabled, setRetrievalEnabled] = React.useState(true);
  const [topK, setTopK] = React.useState<string>(String(DEFAULT_RETRIEVAL_TOP_K));
  const [minSim, setMinSim] = React.useState<string>(
    String(DEFAULT_RETRIEVAL_MIN_SIMILARITY),
  );
  const [busy, setBusy] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement | null>(null);
  useFormShortcuts(formRef, open);

  React.useEffect(() => {
    if (!open) {
      setSelected(null);
      setMode(AttachedLoreMode.READ_ONLY);
      setRetrievalEnabled(true);
      setTopK(String(DEFAULT_RETRIEVAL_TOP_K));
      setMinSim(String(DEFAULT_RETRIEVAL_MIN_SIMILARITY));
    }
  }, [open]);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!selected) {
      toast.error("Pick a Lore Book to attach");
      return;
    }
    let retrieval_top_k: number | null;
    let retrieval_min_similarity: number | null;
    if (!retrievalEnabled) {
      retrieval_top_k = null;
      retrieval_min_similarity = null;
    } else {
      const k = Number.parseInt(topK, 10);
      const sim = Number.parseFloat(minSim);
      if (!Number.isFinite(k) || k <= 0) {
        toast.error("Top-K must be a positive integer");
        return;
      }
      if (!Number.isFinite(sim) || sim < 0 || sim > 1) {
        toast.error("Min similarity must be between 0 and 1");
        return;
      }
      retrieval_top_k = k;
      retrieval_min_similarity = sim;
    }
    setBusy(true);
    try {
      await attachLoreBook({
        project_id,
        lore_id: selected,
        mode,
        retrieval_top_k,
        retrieval_min_similarity,
      });
      onOpenChange(false);
      toast.success("Lore Book attached.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not attach: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const available = (books ?? []).filter((b) => !attached_ids.has(b.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach a Lore Book</DialogTitle>
          <DialogDescription>
            Glossary entries from attached Lore Books are projected into
            the translator prompts. The project's own entries always win
            over Lore-Book entries on conflicts.
          </DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          onSubmit={(e) => void onSubmit(e)}
          className="space-y-3"
        >
          {books === undefined ? (
            <div className="h-12 animate-pulse rounded-md bg-muted/50" />
          ) : available.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              No Lore Books available. Create one from the{" "}
              <span className="font-medium text-foreground">Lore Books</span>{" "}
              screen first.
            </div>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border">
              {available.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(b.id)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                      selected === b.id
                        ? "bg-accent"
                        : "hover:bg-accent/40"
                    }`}
                  >
                    <Book className="size-3.5 text-primary" />
                    <span className="flex-1 truncate">{b.name}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {b.source_lang} → {b.target_lang}
                    </Badge>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {b.entries_total} entries
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div>
            <p className="mb-1 text-xs font-medium text-foreground">Mode</p>
            <div className="flex gap-2 text-sm">
              {(
                [
                  [AttachedLoreMode.READ_ONLY, "Read-only"],
                  [AttachedLoreMode.WRITABLE, "Writable"],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 transition-colors ${
                    mode === value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:bg-accent"
                  }`}
                >
                  <input
                    type="radio"
                    name="lore-mode"
                    className="hidden"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Writable mode lets confirmed entries from this project flow back
              into the Lore Book.
            </p>
          </div>

          <div className="rounded-md border bg-muted/30 p-3">
            <label className="flex items-center gap-2 text-xs font-medium text-foreground">
              <input
                type="checkbox"
                checked={retrievalEnabled}
                onChange={(e) => setRetrievalEnabled(e.target.checked)}
              />
              Use embedding retrieval (top-K)
            </label>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              When enabled, only the entries whose embedding is closest to the
              current segment are injected into the prompt. Requires an
              embedding provider configured in Settings. Disable to flatten the
              entire Lore Book into every prompt (legacy behaviour).
            </p>
            {retrievalEnabled ? (
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <label className="space-y-1">
                  <span className="text-muted-foreground">Top-K</span>
                  <input
                    type="number"
                    min={1}
                    max={128}
                    step={1}
                    value={topK}
                    onChange={(e) => setTopK(e.target.value)}
                    className="w-full rounded-md border bg-background px-2 py-1"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-muted-foreground">Min cosine</span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={minSim}
                    onChange={(e) => setMinSim(e.target.value)}
                    className="w-full rounded-md border bg-background px-2 py-1"
                  />
                </label>
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !selected}>
              {busy ? "Attaching…" : "Attach"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
