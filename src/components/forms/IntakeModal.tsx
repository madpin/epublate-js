/**
 * Book-intake modal — kicks off the helper-LLM one-shot pre-pass.
 *
 * Mirrors `epublate.app.modals.IntakeModal`. The intake auto-proposes
 * glossary entries and surfaces a draft style profile, both of which
 * land in the curator's Inbox. Cache hits cost nothing, so re-running
 * after a glossary edit is cheap.
 */

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFormShortcuts } from "@/hooks/useFormShortcuts";
import { useRunIntake } from "@/hooks/useRunIntake";

interface IntakeModalProps {
  project_id: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  default_helper_model?: string | null;
}

export function IntakeModal({
  project_id,
  open,
  onOpenChange,
  default_helper_model,
}: IntakeModalProps): React.JSX.Element {
  const [max_segments, setMaxSegments] = React.useState("30");
  const [chunk_max_tokens, setChunkMaxTokens] = React.useState("1500");
  const [helper_model, setHelperModel] = React.useState(
    default_helper_model ?? "",
  );
  const [bypass_cache, setBypassCache] = React.useState(false);
  const { start, busy } = useRunIntake();
  const formRef = React.useRef<HTMLFormElement | null>(null);
  useFormShortcuts(formRef, open);

  React.useEffect(() => {
    if (open) {
      setMaxSegments("30");
      setChunkMaxTokens("1500");
      setHelperModel(default_helper_model ?? "");
      setBypassCache(false);
    }
  }, [open, default_helper_model]);

  const onStart = async (): Promise<void> => {
    const max_n = Math.max(1, Number(max_segments) || 30);
    const chunk_n = Math.max(200, Number(chunk_max_tokens) || 1500);
    onOpenChange(false);
    await start({
      project_id,
      max_segments: max_n,
      chunk_max_tokens: chunk_n,
      bypass_cache,
      helper_model: helper_model.trim() || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run book intake</DialogTitle>
          <DialogDescription>
            Reads the opening segments of the book, sniffs proper
            nouns and recurring phrases, and proposes them to your
            glossary. Also drafts a style profile from the prose's
            register and audience.
          </DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          onSubmit={(ev) => {
            ev.preventDefault();
            void onStart();
          }}
        >
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="i-max-segments">Segments to read</Label>
            <Input
              id="i-max-segments"
              type="number"
              min={1}
              max={500}
              value={max_segments}
              onChange={(e) => setMaxSegments(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Reads from the start of the book in spine order.
            </p>
          </div>
          <div>
            <Label htmlFor="i-chunk">Chunk size (tokens)</Label>
            <Input
              id="i-chunk"
              type="number"
              min={200}
              max={8000}
              step={100}
              value={chunk_max_tokens}
              onChange={(e) => setChunkMaxTokens(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Larger chunks are cheaper but give the helper more to
              keep in mind at once.
            </p>
          </div>
          <div className="col-span-2">
            <Label htmlFor="i-helper-model">Helper model (optional)</Label>
            <Input
              id="i-helper-model"
              value={helper_model}
              onChange={(e) => setHelperModel(e.target.value)}
              placeholder="(falls back to project / library helper model)"
            />
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <input
              id="i-bypass"
              type="checkbox"
              checked={bypass_cache}
              onChange={(e) => setBypassCache(e.target.checked)}
            />
            <Label htmlFor="i-bypass">
              Bypass cache (re-extract from scratch)
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Running…" : "Start intake"}
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
