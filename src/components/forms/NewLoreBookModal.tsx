import * as React from "react";
import { useNavigate } from "react-router-dom";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LoreSourceKind, type LoreSourceKindT } from "@/db/schema";
import { useFormShortcuts } from "@/hooks/useFormShortcuts";
import { createLoreBook } from "@/lore/lore";

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
}

interface FormState {
  name: string;
  source_lang: string;
  target_lang: string;
  description: string;
  default_proposal_kind: LoreSourceKindT;
  busy: boolean;
}

const initial: FormState = {
  name: "",
  source_lang: "ja",
  target_lang: "pt",
  description: "",
  default_proposal_kind: LoreSourceKind.TARGET,
  busy: false,
};

export function NewLoreBookModal({
  open,
  onOpenChange,
}: Props): React.JSX.Element {
  const [state, setState] = React.useState<FormState>(initial);
  const navigate = useNavigate();
  const formRef = React.useRef<HTMLFormElement | null>(null);
  useFormShortcuts(formRef, open);

  React.useEffect(() => {
    if (!open) setState(initial);
  }, [open]);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!state.name.trim()) {
      toast.error("Lore Book name is required");
      return;
    }
    setState((s) => ({ ...s, busy: true }));
    try {
      const handle = await createLoreBook({
        name: state.name.trim(),
        source_lang: state.source_lang.trim() || "ja",
        target_lang: state.target_lang.trim() || "pt",
        description: state.description.trim() || null,
        default_proposal_kind: state.default_proposal_kind,
      });
      toast.success(`Created Lore Book “${handle.name}”`);
      onOpenChange(false);
      navigate(`/lore/${handle.id}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not create Lore Book: ${msg}`);
    } finally {
      setState((s) => ({ ...s, busy: false }));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Lore Book</DialogTitle>
          <DialogDescription>
            A Lore Book is a portable glossary you can attach to many
            translation projects. It lives in its own database in this
            browser; nothing leaves your device.
          </DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          onSubmit={(e) => void onSubmit(e)}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={state.name}
              onChange={(e) =>
                setState((s) => ({ ...s, name: e.target.value }))
              }
              placeholder="Witcher Lore (PT)"
              disabled={state.busy}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="src">Source language</Label>
              <Input
                id="src"
                value={state.source_lang}
                onChange={(e) =>
                  setState((s) => ({ ...s, source_lang: e.target.value }))
                }
                disabled={state.busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tgt">Target language</Label>
              <Input
                id="tgt"
                value={state.target_lang}
                onChange={(e) =>
                  setState((s) => ({ ...s, target_lang: e.target.value }))
                }
                disabled={state.busy}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="desc">Description (optional)</Label>
            <Textarea
              id="desc"
              value={state.description}
              onChange={(e) =>
                setState((s) => ({ ...s, description: e.target.value }))
              }
              placeholder="Series notes, scope, conventions"
              disabled={state.busy}
              rows={3}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Default proposal kind</Label>
            <div className="flex flex-wrap gap-2 text-sm">
              {(
                [
                  [LoreSourceKind.TARGET, "Target-only"],
                  [LoreSourceKind.SOURCE, "Source + target"],
                ] as const
              ).map(([kind, label]) => (
                <label
                  key={kind}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 transition-colors ${
                    state.default_proposal_kind === kind
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:bg-accent"
                  }`}
                >
                  <input
                    type="radio"
                    name="kind"
                    className="hidden"
                    value={kind}
                    checked={state.default_proposal_kind === kind}
                    onChange={() =>
                      setState((s) => ({
                        ...s,
                        default_proposal_kind: kind,
                      }))
                    }
                    disabled={state.busy}
                  />
                  {label}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Target-only Lore Books pin canonical translations of recurring
              entities and never see the source spelling.
            </p>
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={state.busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={state.busy}>
              {state.busy ? "Creating…" : "Create Lore Book"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
