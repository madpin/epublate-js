import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { libraryDb } from "@/db/library";
import { useFormShortcuts } from "@/hooks/useFormShortcuts";
import { importProjectGlossary } from "@/lore/import_project";

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  lore_id: string;
}

export function ImportProjectModal(props: Props): React.JSX.Element {
  const projects = useLiveQuery(
    async () => {
      const all = await libraryDb().projects.toArray();
      all.sort((a, b) => b.created_at - a.created_at);
      return all;
    },
    [],
    [],
  );

  const [project_id, setProjectId] = React.useState<string>("");
  const [policy, setPolicy] =
    React.useState<"skip" | "overwrite">("skip");
  const [busy, setBusy] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement | null>(null);
  useFormShortcuts(formRef, props.open);

  React.useEffect(() => {
    if (props.open) {
      setProjectId("");
      setPolicy("skip");
    }
  }, [props.open]);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!project_id) {
      toast.error("Pick a project to import from.");
      return;
    }
    setBusy(true);
    try {
      const summary = await importProjectGlossary({
        source_project_id: project_id,
        dest_lore_id: props.lore_id,
        policy,
      });
      toast.success(
        `Imported: +${summary.created} created, ${summary.updated} updated, ${summary.skipped} skipped.`,
      );
      props.onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Import failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import glossary from project</DialogTitle>
          <DialogDescription>
            Copy glossary entries from an existing translation project into
            this Lore Book.
          </DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          onSubmit={(e) => void onSubmit(e)}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="proj">Source project</Label>
            <select
              id="proj"
              value={project_id}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={busy}
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
            >
              <option value="">— select —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.source_lang} → {p.target_lang})
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label>On conflict (same source term + type)</Label>
            <div className="flex gap-3 text-sm">
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="radio"
                  name="policy"
                  value="skip"
                  checked={policy === "skip"}
                  onChange={() => setPolicy("skip")}
                  disabled={busy}
                />
                Keep existing
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="radio"
                  name="policy"
                  value="overwrite"
                  checked={policy === "overwrite"}
                  onChange={() => setPolicy("overwrite")}
                  disabled={busy}
                />
                Overwrite with project
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              Target-only entries are always inserted (different Lore Books may
              pin the same proper noun for unrelated entities).
            </p>
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
            <Button type="submit" disabled={busy || !project_id}>
              {busy ? "Importing…" : "Import"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
