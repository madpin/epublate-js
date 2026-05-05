import * as React from "react";
import { useDropzone } from "react-dropzone";
import { Loader2, UploadCloud } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useFormShortcuts } from "@/hooks/useFormShortcuts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LLMConfigurationError } from "@/llm/base";
import { buildProvider } from "@/llm/factory";
import { useAppStore } from "@/state/app";
import { ingestSourceEpub } from "@/lore/ingest";
import { ingestTargetEpub } from "@/lore/ingest_target";
import { LoreSourceKind, type LoreSourceKindT } from "@/db/schema";

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  lore_id: string;
  source_lang: string;
  target_lang: string;
  default_kind: LoreSourceKindT;
}

export function IngestEpubModal(props: Props): React.JSX.Element {
  const [file, setFile] = React.useState<File | null>(null);
  const [kind, setKind] = React.useState(props.default_kind);
  const [busy, setBusy] = React.useState(false);
  const mock_mode = useAppStore((s) => s.mock_mode);
  const formRef = React.useRef<HTMLFormElement | null>(null);
  useFormShortcuts(formRef, props.open);

  React.useEffect(() => {
    if (!props.open) {
      setFile(null);
      setKind(props.default_kind);
    }
  }, [props.open, props.default_kind]);

  const onDrop = React.useCallback((accepted: File[]) => {
    const f = accepted[0];
    if (f) setFile(f);
  }, []);
  const dz = useDropzone({
    onDrop,
    multiple: false,
    accept: { "application/epub+zip": [".epub"] },
    disabled: busy,
  });

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!file) {
      toast.error("Pick an ePub file first");
      return;
    }
    setBusy(true);
    try {
      let provider;
      let model = "gpt-4o-mini";
      try {
        const built = await buildProvider({ mock: mock_mode });
        provider = built.provider;
        if (built.resolved?.helper_model) {
          model = built.resolved.helper_model;
        } else if (built.resolved?.translator_model) {
          model = built.resolved.translator_model;
        }
      } catch (err) {
        if (err instanceof LLMConfigurationError) {
          toast.error(
            "LLM not configured. Set an endpoint and model in Settings.",
          );
          return;
        }
        throw err;
      }
      const bytes = await file.arrayBuffer();
      const opts = { model };
      let summary;
      if (kind === LoreSourceKind.TARGET) {
        summary = await ingestTargetEpub({
          lore_id: props.lore_id,
          bytes,
          filename: file.name,
          target_lang: props.target_lang,
          provider,
          options: opts,
        });
      } else {
        summary = await ingestSourceEpub({
          lore_id: props.lore_id,
          bytes,
          filename: file.name,
          source_lang: props.source_lang,
          target_lang: props.target_lang,
          provider,
          options: opts,
        });
      }
      toast.success(
        `Ingest done — ${summary.proposed_count} entries proposed (${summary.failed_chunks} failed chunks).`,
      );
      props.onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Ingest failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ingest an ePub</DialogTitle>
          <DialogDescription>
            The helper LLM walks the first few chapters and proposes glossary
            entries to seed this Lore Book. Stays entirely in your browser;
            calls go directly from here to your configured endpoint.
          </DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          onSubmit={(e) => void onSubmit(e)}
          className="space-y-3"
        >
          <div>
            <p className="mb-1 text-xs font-medium">Mode</p>
            <div className="flex gap-2 text-sm">
              {(
                [
                  [LoreSourceKind.TARGET, "Target-language ePub"],
                  [LoreSourceKind.SOURCE, "Source-language ePub"],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 transition-colors ${
                    kind === value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:bg-accent"
                  }`}
                >
                  <input
                    type="radio"
                    name="ingest-kind"
                    className="hidden"
                    value={value}
                    checked={kind === value}
                    onChange={() => setKind(value)}
                    disabled={busy}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <div
            {...dz.getRootProps()}
            className={`flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-6 text-sm transition-colors ${
              dz.isDragActive ? "bg-accent" : ""
            }`}
          >
            <input {...dz.getInputProps()} />
            <UploadCloud className="size-6 text-muted-foreground" />
            {file ? (
              <span className="font-medium">{file.name}</span>
            ) : (
              <span className="text-muted-foreground">
                Drop an .epub file here, or click to pick.
              </span>
            )}
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
            <Button type="submit" disabled={busy || !file}>
              {busy ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Ingesting…
                </>
              ) : (
                "Ingest"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
