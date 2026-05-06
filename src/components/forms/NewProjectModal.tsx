import * as React from "react";
import { useDropzone } from "react-dropzone";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Loader2, UploadCloud } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ConfirmDiscardDialog,
  useConfirmDiscard,
} from "@/components/ui/confirm-discard-dialog";
import { useFormShortcuts } from "@/hooks/useFormShortcuts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LanguagePicker } from "@/components/forms/LanguagePicker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { runBookIntake } from "@/core/extractor";
import { runProjectIntake } from "@/core/project_intake";
import {
  DEFAULT_STYLE_PROFILE,
  getProfile,
  listProfiles,
} from "@/core/style";
import { sniffTone } from "@/core/style_sniff";
import { createProject, deleteProject } from "@/db/repo/projects";
import { LLMConfigurationError } from "@/llm/base";
import { buildProvider } from "@/llm/factory";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/state/app";

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
}

interface FormState {
  name: string;
  source_lang: string;
  target_lang: string;
  file: File | null;
  busy: boolean;
  style_profile: string;
  style_guide: string;
}

const initial: FormState = {
  name: "",
  source_lang: "en",
  target_lang: "pt-BR",
  file: null,
  busy: false,
  style_profile: DEFAULT_STYLE_PROFILE,
  style_guide: getProfile(DEFAULT_STYLE_PROFILE)?.prompt_block ?? "",
};

function buildInitialState(
  last_source: string | null | undefined,
  last_target: string | null | undefined,
): FormState {
  return {
    ...initial,
    source_lang: (last_source ?? "").trim() || initial.source_lang,
    target_lang: (last_target ?? "").trim() || initial.target_lang,
  };
}

export function NewProjectModal({ open, onOpenChange }: Props): React.JSX.Element {
  const last_source_lang = useAppStore((s) => s.ui.last_source_lang);
  const last_target_lang = useAppStore((s) => s.ui.last_target_lang);
  const setUiPref = useAppStore((s) => s.setUiPref);
  const [state, setState] = React.useState<FormState>(() =>
    buildInitialState(last_source_lang, last_target_lang),
  );
  const [auto_intake, setAutoIntake] = React.useState(true);
  const auto_tone_sniff = useAppStore((s) => s.ui.auto_tone_sniff);
  const [tone_sniff, setToneSniff] = React.useState(auto_tone_sniff);
  const mock_mode = useAppStore((s) => s.mock_mode);
  const navigate = useNavigate();

  React.useEffect(() => {
    setToneSniff(auto_tone_sniff);
  }, [auto_tone_sniff]);

  // When the modal re-opens, refresh the language defaults from the
  // store. We *don't* override values the user is mid-editing — only
  // the prefilled "first time you opened this modal" snapshot.
  React.useEffect(() => {
    if (!open) return;
    setState((s) => {
      if (s.busy) return s;
      // Only refresh if the user hasn't started typing names / changing
      // the languages from the prior session's defaults.
      if (s.name.trim() || s.file) return s;
      return buildInitialState(last_source_lang, last_target_lang);
    });
  }, [open, last_source_lang, last_target_lang]);

  const onProfileChange = React.useCallback((profile_id: string): void => {
    const profile = getProfile(profile_id);
    setState((s) => ({
      ...s,
      style_profile: profile_id,
      style_guide: profile?.prompt_block ?? s.style_guide,
    }));
  }, []);

  const onDrop = React.useCallback((accepted: File[]) => {
    const file = accepted[0];
    if (!file) return;
    setState((s) => ({
      ...s,
      file,
      name: s.name || stripExtension(file.name),
    }));
  }, []);

  const dropzone = useDropzone({
    onDrop,
    accept: {
      "application/epub+zip": [".epub"],
    },
    maxFiles: 1,
    multiple: false,
    disabled: state.busy,
  });

  const reset = React.useCallback(
    () => setState(buildInitialState(last_source_lang, last_target_lang)),
    [last_source_lang, last_target_lang],
  );
  const formRef = React.useRef<HTMLFormElement | null>(null);
  useFormShortcuts(formRef, open);

  // Selecting an .epub via drag-and-drop or the file picker is a
  // time-consuming step (open Finder, navigate, drop). Once the
  // curator has done it, an accidental click outside or stray Esc
  // shouldn't silently throw it away — pop a confirm instead. The
  // explicit Cancel and X close paths still bypass the confirm; this
  // only intercepts implicit dismissals.
  const has_progress = state.file !== null;
  const discard_guard = useConfirmDiscard({
    enabled: open && has_progress && !state.busy,
  });

  const submit = async (): Promise<void> => {
    if (!state.file) {
      toast.error("Pick or drop an .epub file first.");
      return;
    }
    if (!state.name.trim()) {
      toast.error("Project name is required.");
      return;
    }
    setState((s) => ({ ...s, busy: true }));
    let project_id: string | null = null;
    try {
      const bytes = await state.file.arrayBuffer();
      const final_source = state.source_lang.trim() || "auto";
      const final_target = state.target_lang.trim() || "en";
      const project = await createProject({
        name: state.name.trim(),
        source_lang: final_source,
        target_lang: final_target,
        source_filename: state.file.name,
        source_bytes: bytes,
        style_profile: state.style_profile || null,
        style_guide: state.style_guide.trim() || null,
      });
      project_id = project.id;
      // Remember these for the next "New project" modal so curators
      // who repeatedly translate from JA → PT (or whatever pair) only
      // pick the languages once. Best-effort — if the write fails,
      // the project is already on disk and the modal works fine.
      try {
        await Promise.all([
          setUiPref("last_source_lang", final_source),
          setUiPref("last_target_lang", final_target),
        ]);
      } catch {
        // ignore
      }
      // Intake: parse + segment the ePub. ArrayBuffers are detached
      // by `createProject` storing them, so we re-read from the file.
      const intake_bytes = await state.file.arrayBuffer();
      const result = await runProjectIntake({
        project_id: project.id,
        source_lang: project.source_lang,
        target_lang: project.target_lang,
        epub_bytes: intake_bytes,
        source_filename: state.file.name,
      });
      toast.success(`Created project “${project.name}”`, {
        description: `${result.chapters} chapters, ${result.segments} segments imported.`,
      });
      onOpenChange(false);
      reset();
      void requestPersistentStorage();
      navigate(`/project/${project.id}`);
      // Best-effort book intake — auto-proposes the opening glossary
      // and the suggested style profile. If LLM isn't configured yet
      // we silently bail; the curator can run it from the Intake
      // runs screen later.
      if (auto_intake) {
        void runBestEffortBookIntake({
          project_id: project.id,
          source_lang: project.source_lang,
          target_lang: project.target_lang,
          mock_mode,
        });
      }
      // Best-effort tone sniff — runs three short helper calls to
      // characterize the prose's register/audience and updates the
      // project's `style_profile` if the curator hasn't customized it.
      if (tone_sniff) {
        void runBestEffortStyleSniff({
          project_id: project.id,
          source_lang: project.source_lang,
          target_lang: project.target_lang,
          mock_mode,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Could not create project: ${message}`);
      // If we got far enough to create the project but intake blew up,
      // roll back so the user doesn't see a half-imported book in the
      // recents list. Best-effort.
      if (project_id) {
        try {
          await deleteProject(project_id);
        } catch {
          // ignore — already noisy enough
        }
      }
      setState((s) => ({ ...s, busy: false }));
    }
  };

  React.useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent {...discard_guard.contentProps}>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Drop an ePub. The book stays on your device — only the
            translation prompts ever travel to your configured LLM.
          </DialogDescription>
        </DialogHeader>

        <form
          ref={formRef}
          onSubmit={(ev) => {
            ev.preventDefault();
            void submit();
          }}
        >
        <div className="grid gap-4 py-2">
          <div
            {...dropzone.getRootProps()}
            className={cn(
              "flex h-32 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed text-sm transition-colors",
              dropzone.isDragActive
                ? "border-primary bg-primary/5 text-primary"
                : "border-input hover:border-primary/50",
              state.busy && "pointer-events-none opacity-50",
            )}
          >
            <input {...dropzone.getInputProps()} />
            <UploadCloud className="size-5" />
            {state.file ? (
              <div className="text-center">
                <div className="font-medium">{state.file.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {(state.file.size / 1024 / 1024).toFixed(2)} MB
                </div>
              </div>
            ) : (
              <span className="text-muted-foreground">
                Drop an .epub here or click to browse
              </span>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="np-name">Name</Label>
            <Input
              id="np-name"
              value={state.name}
              onChange={(e) =>
                setState((s) => ({ ...s, name: e.target.value }))
              }
              placeholder="Title of the book"
              disabled={state.busy}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="np-src">Source language</Label>
              <LanguagePicker
                id="np-src"
                value={state.source_lang}
                onChange={(next) =>
                  setState((s) => ({ ...s, source_lang: next }))
                }
                placeholder="e.g. en"
                disabled={state.busy}
                validateOnBlur
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="np-tgt">Target language</Label>
              <LanguagePicker
                id="np-tgt"
                value={state.target_lang}
                onChange={(next) =>
                  setState((s) => ({ ...s, target_lang: next }))
                }
                placeholder="e.g. pt-BR"
                disabled={state.busy}
                validateOnBlur
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="np-style-profile">Style profile</Label>
            <select
              id="np-style-profile"
              value={state.style_profile}
              onChange={(e) => onProfileChange(e.target.value)}
              disabled={state.busy}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {listProfiles().map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              {getProfile(state.style_profile)?.description ??
                "Custom style — see field below."}
            </p>
            <Textarea
              id="np-style-guide"
              value={state.style_guide}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  style_guide: e.target.value,
                }))
              }
              rows={4}
              disabled={state.busy}
              placeholder="Style guide prose the translator's system prompt embeds. Edit freely; your changes win over the preset."
              className="font-mono text-[11px]"
            />
          </div>

          <div className="flex items-start gap-2">
            <input
              id="np-intake"
              type="checkbox"
              className="mt-1"
              checked={auto_intake}
              onChange={(e) => setAutoIntake(e.target.checked)}
              disabled={state.busy}
            />
            <div className="flex-1">
              <Label htmlFor="np-intake">
                Run helper-LLM book intake automatically
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Sniffs proper nouns and recurring phrases from the
                opening of the book to seed your glossary. Skipped if
                no LLM is configured yet.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <input
              id="np-tone-sniff"
              type="checkbox"
              className="mt-1"
              checked={tone_sniff}
              onChange={(e) => setToneSniff(e.target.checked)}
              disabled={state.busy}
            />
            <div className="flex-1">
              <Label htmlFor="np-tone-sniff">
                Auto-detect register / audience
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Reads three short passages from the head, middle, and
                tail of the book and suggests a tone preset. Skipped if
                no LLM is configured yet.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={state.busy}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={state.busy}>
            {state.busy ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Creating…
              </>
            ) : (
              "Create project"
            )}
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <ConfirmDiscardDialog
      open={discard_guard.confirm_open}
      onOpenChange={discard_guard.setConfirmOpen}
      title="Discard new project?"
      description={
        state.file ? (
          <>
            You&apos;ve picked{" "}
            <span className="font-medium text-foreground">
              {state.file.name}
            </span>
            . Closing now will lose the selection — you&apos;ll have to
            pick the ePub again.
          </>
        ) : (
          "You have unsaved changes. Closing now will lose them."
        )
      }
      discard_label="Discard"
      keep_label="Keep editing"
      onConfirm={() => {
        discard_guard.setConfirmOpen(false);
        onOpenChange(false);
      }}
    />
    </>
  );
}

function stripExtension(name: string): string {
  return name.replace(/\.epub$/i, "");
}

interface BestEffortBookIntakeInput {
  project_id: string;
  source_lang: string;
  target_lang: string;
  mock_mode: boolean;
}

async function runBestEffortStyleSniff(
  input: BestEffortBookIntakeInput,
): Promise<void> {
  let provider;
  let helper_model: string;
  try {
    const built = await buildProvider({ mock: input.mock_mode });
    provider = built.provider;
    helper_model =
      built.resolved?.helper_model ??
      built.resolved?.translator_model ??
      "mock-model";
  } catch (err: unknown) {
    if (err instanceof LLMConfigurationError) {
      // Quietly skip — book intake helper showed the config hint already.
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    toast.error(`Could not start tone sniff: ${msg}`);
    return;
  }
  try {
    const summary = await sniffTone({
      project_id: input.project_id,
      source_lang: input.source_lang,
      target_lang: input.target_lang,
      provider,
      helper_model,
    });
    if (summary.profile) {
      const verb = summary.applied ? "applied" : "suggested";
      toast.success(
        `Tone sniff ${verb}: ${summary.profile.replace(/_/g, " ")}`,
        {
          description: `register=${summary.register ?? "—"} · audience=${summary.audience ?? "—"}`,
        },
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error(`Tone sniff failed: ${msg}`);
  }
}

async function runBestEffortBookIntake(
  input: BestEffortBookIntakeInput,
): Promise<void> {
  let provider;
  let helper_model: string;
  try {
    const built = await buildProvider({ mock: input.mock_mode });
    provider = built.provider;
    helper_model =
      built.resolved?.helper_model ??
      built.resolved?.translator_model ??
      "mock-model";
  } catch (err: unknown) {
    if (err instanceof LLMConfigurationError) {
      toast.message("LLM not configured — book intake skipped.", {
        description:
          "Open Settings → LLM, then run the intake from the project's Intake screen.",
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    toast.error(`Could not start book intake: ${msg}`);
    return;
  }
  try {
    const summary = await runBookIntake({
      project_id: input.project_id,
      source_lang: input.source_lang,
      target_lang: input.target_lang,
      provider,
      options: { model: helper_model, auto_propose: true },
    });
    if (summary.proposed_count > 0) {
      toast.success(
        `Book intake done · ${summary.proposed_count} entries proposed`,
      );
    } else if (summary.failed_chunks > 0) {
      toast.warning(
        `Book intake finished with ${summary.failed_chunks} failed chunk${summary.failed_chunks === 1 ? "" : "s"}`,
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error(`Book intake failed: ${msg}`);
  }
}

async function requestPersistentStorage(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return;
  try {
    const granted = await navigator.storage.persist();
    if (granted) {
      toast.success("Persistent storage granted.", {
        description: "Your projects won't be evicted when storage is tight.",
      });
    }
  } catch {
    // Ignored — best-effort.
  }
}
