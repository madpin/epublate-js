/**
 * Per-project settings screen.
 *
 * The Python tool gathered every project knob in one place; the
 * browser port had been spreading them across modals (style guide)
 * and "edit your `llm_overrides` JSON in DevTools, sorry" gaps. This
 * route reunifies them so a curator can:
 *
 * - Rename the project (kept in sync with the library row).
 * - Swap the active style profile / guide without leaving the page.
 * - Set the per-project budget cap that pre-fills the Batch modal.
 * - Configure the **context segments** window. The pipeline now
 *   pulls up to `max_segments` previous source/target pairs from the
 *   same chapter and feeds them to the translator as
 *   "Preceding segments (context only)" — so the LLM keeps tone /
 *   pronouns consistent across paragraphs.
 * - Override the LLM endpoint (URL, translator model, helper model,
 *   reasoning effort) for this project only — useful when one book
 *   needs a heavier model than your global default.
 *
 * Every save runs through `updateProjectSettings`, which writes a
 * `project.updated` event so the audit log stays honest.
 */

import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, Save, Settings as SettingsIcon } from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_STYLE_PROFILE,
  getProfile,
  listProfiles,
} from "@/core/style";
import { openProjectDb } from "@/db/dexie";
import { libraryDb } from "@/db/library";
import { updateProjectSettings } from "@/db/repo/projects";
import { useFormShortcuts } from "@/hooks/useFormShortcuts";
import type { ProjectLlmOverrides } from "@/llm/factory";
import { useUiStore } from "@/state/ui";

type ReasoningEffort = "" | "minimal" | "low" | "medium" | "high";
type ContextMode = "off" | "previous" | "dialogue";

interface FormState {
  name: string;
  style_profile: string;
  style_guide: string;
  budget_usd: string;
  context_max_segments: string;
  context_max_chars: string;
  context_mode: ContextMode;
  llm_base_url: string;
  llm_translator_model: string;
  llm_helper_model: string;
  llm_reasoning_effort: ReasoningEffort;
}

const EMPTY_FORM: FormState = {
  name: "",
  style_profile: DEFAULT_STYLE_PROFILE,
  style_guide: "",
  budget_usd: "",
  context_max_segments: "0",
  context_max_chars: "0",
  context_mode: "previous",
  llm_base_url: "",
  llm_translator_model: "",
  llm_helper_model: "",
  llm_reasoning_effort: "",
};

export function ProjectSettingsRoute(): React.JSX.Element {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const setActiveScreen = useUiStore((s) => s.setActiveScreen);
  React.useEffect(
    () => setActiveScreen("project-settings"),
    [setActiveScreen],
  );

  const project = useLiveQuery(
    async () => libraryDb().projects.get(projectId),
    [projectId],
  );
  const detail = useLiveQuery(
    async () => {
      if (!projectId) return null;
      const db = openProjectDb(projectId);
      return (await db.projects.get(projectId)) ?? null;
    },
    [projectId],
  );

  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = React.useState(false);
  const initial_loaded = React.useRef(false);
  const formRef = React.useRef<HTMLFormElement | null>(null);
  useFormShortcuts(formRef, true);

  React.useEffect(() => {
    if (!detail || initial_loaded.current) return;
    initial_loaded.current = true;
    let overrides: ProjectLlmOverrides | null = null;
    if (detail.llm_overrides) {
      try {
        overrides = JSON.parse(detail.llm_overrides) as ProjectLlmOverrides;
      } catch {
        overrides = null;
      }
    }
    setForm({
      name: detail.name,
      style_profile: detail.style_profile ?? DEFAULT_STYLE_PROFILE,
      style_guide:
        detail.style_guide ??
        getProfile(detail.style_profile ?? DEFAULT_STYLE_PROFILE)
          ?.prompt_block ??
        "",
      budget_usd:
        detail.budget_usd != null && Number.isFinite(detail.budget_usd)
          ? String(detail.budget_usd)
          : "",
      context_max_segments: String(detail.context_max_segments ?? 0),
      context_max_chars: String(detail.context_max_chars ?? 0),
      context_mode: (detail.context_mode ?? "previous") as ContextMode,
      llm_base_url: overrides?.base_url ?? "",
      llm_translator_model: overrides?.translator_model ?? "",
      llm_helper_model: overrides?.helper_model ?? "",
      llm_reasoning_effort: (overrides?.reasoning_effort ?? "") as ReasoningEffort,
    });
  }, [detail]);

  const setField = React.useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const onProfileChange = (id: string): void => {
    const profile = getProfile(id);
    setForm((prev) => ({
      ...prev,
      style_profile: id,
      style_guide: profile?.prompt_block ?? prev.style_guide,
    }));
  };

  const onSave = async (ev?: React.FormEvent): Promise<void> => {
    ev?.preventDefault();
    if (!projectId) return;
    setBusy(true);
    try {
      const trimmed_name = form.name.trim();
      if (!trimmed_name) {
        toast.error("Project name cannot be empty.");
        return;
      }
      const budget_n = form.budget_usd.trim()
        ? Number(form.budget_usd)
        : null;
      const segs_n = clampInt(form.context_max_segments, 0, 50);
      const chars_n = clampInt(form.context_max_chars, 0, 100_000);
      const overrides: ProjectLlmOverrides = {};
      if (form.llm_base_url.trim()) overrides.base_url = form.llm_base_url.trim();
      if (form.llm_translator_model.trim()) {
        overrides.translator_model = form.llm_translator_model.trim();
      }
      if (form.llm_helper_model.trim()) {
        overrides.helper_model = form.llm_helper_model.trim();
      }
      if (form.llm_reasoning_effort) {
        overrides.reasoning_effort = form.llm_reasoning_effort;
      }
      const has_overrides = Object.keys(overrides).length > 0;
      await updateProjectSettings(projectId, {
        name: trimmed_name,
        style_profile: form.style_profile || null,
        style_guide: form.style_guide.trim() || null,
        budget_usd:
          budget_n !== null && Number.isFinite(budget_n) ? budget_n : null,
        context_max_segments: segs_n,
        context_max_chars: chars_n,
        context_mode: form.context_mode,
        llm_overrides: has_overrides ? overrides : null,
      });
      toast.success("Project settings saved.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not save: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  if (project === undefined || detail === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading project…
      </div>
    );
  }
  if (!project || !detail) {
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

  const profile = getProfile(form.style_profile);
  const has_custom_guide =
    profile != null && form.style_guide.trim() !== profile.prompt_block.trim();

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={`/project/${projectId}`}
            className="flex size-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent"
            aria-label="Back to dashboard"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <SettingsIcon className="size-4 text-primary" />
              <h1 className="truncate text-xl font-semibold tracking-tight">
                Project settings
              </h1>
              <Badge variant="outline" className="text-[10px]">
                {project.source_lang} → {project.target_lang}
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {project.name} · {project.source_filename}
            </p>
          </div>
        </div>
        <Button
          onClick={() => void onSave()}
          disabled={busy}
          className="gap-2"
        >
          <Save className="size-3.5" />
          {busy ? "Saving…" : "Save"}
        </Button>
      </header>

      <form
        ref={formRef}
        onSubmit={(ev) => void onSave(ev)}
        className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-6"
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Identity</CardTitle>
            <CardDescription>
              Display name + read-only ePub metadata. The renamed project
              shows up immediately on the projects list.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ps-name">Project name</Label>
              <Input
                id="ps-name"
                value={form.name}
                onChange={(e) => setField("name", e.target.value)}
                disabled={busy}
                placeholder="(name)"
              />
            </div>
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <div className="text-muted-foreground">Source file</div>
                <div className="truncate font-mono">{project.source_filename}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Project ID</div>
                <div className="truncate font-mono">{detail.id}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Languages</div>
                <div>
                  {project.source_lang} → {project.target_lang}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Original size</div>
                <div>
                  {(project.source_size_bytes / 1024 / 1024).toFixed(2)} MB
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Style</CardTitle>
            <CardDescription>
              The translator's system prompt embeds the style guide
              verbatim. Editing it invalidates the cache for this project.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ps-profile">Tone preset</Label>
              <select
                id="ps-profile"
                value={form.style_profile}
                onChange={(e) => onProfileChange(e.target.value)}
                disabled={busy}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {listProfiles().map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                {profile?.description ?? "Custom — only the prose below is used."}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ps-guide">
                Style guide
                {has_custom_guide ? (
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
                    (customized)
                  </span>
                ) : (
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                    (preset default)
                  </span>
                )}
              </Label>
              <Textarea
                id="ps-guide"
                value={form.style_guide}
                onChange={(e) => setField("style_guide", e.target.value)}
                rows={10}
                disabled={busy}
                className="font-mono text-[11px]"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Context window</CardTitle>
            <CardDescription>
              Inject the previous N segments of the same chapter into the
              translator prompt as read-only context. Bigger windows hold
              tone / pronoun / reference consistency across paragraphs but
              cost extra prompt tokens. Set both values to <code>0</code>{" "}
              to disable context entirely (legacy behaviour).
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ps-ctx-mode">Strategy</Label>
              <select
                id="ps-ctx-mode"
                value={form.context_mode}
                onChange={(e) =>
                  setField("context_mode", e.target.value as ContextMode)
                }
                disabled={busy}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="previous">
                  Previous segments (every line gets context)
                </option>
                <option value="dialogue">
                  Dialogue-only (cheap: only conversations)
                </option>
                <option value="off">Off (no context)</option>
              </select>
              <p className="text-[11px] text-muted-foreground">
                <strong>Previous</strong> feeds the last N source/target
                pairs verbatim — best for tone-sensitive prose. <strong>
                  Dialogue-only
                </strong>{" "}
                only adds context when the current segment looks like
                spoken dialogue (curly quotes, em-dashes, corner
                brackets) and pulls only previous translated dialogue
                from the same chapter. Narration translates with no
                context — useful for novels where exchanges are rare
                but pronoun-stable references really matter.{" "}
                <strong>Off</strong> bypasses the window entirely
                regardless of the values below.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="ps-ctx-segs">Max segments</Label>
                <Input
                  id="ps-ctx-segs"
                  type="number"
                  min={0}
                  max={50}
                  value={form.context_max_segments}
                  onChange={(e) =>
                    setField("context_max_segments", e.target.value)
                  }
                  disabled={busy || form.context_mode === "off"}
                />
                <p className="text-[11px] text-muted-foreground">
                  Number of previous segments. Most curators land between 2
                  and 6 — small enough to stay cheap, large enough to keep
                  pronouns stable.
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ps-ctx-chars">Max characters</Label>
                <Input
                  id="ps-ctx-chars"
                  type="number"
                  min={0}
                  max={100_000}
                  value={form.context_max_chars}
                  onChange={(e) =>
                    setField("context_max_chars", e.target.value)
                  }
                  disabled={busy || form.context_mode === "off"}
                />
                <p className="text-[11px] text-muted-foreground">
                  Cumulative character budget across both source and target
                  lines. <code>0</code> means "no budget — use the segment
                  cap above." Useful for chapters with very long
                  paragraphs.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Budget</CardTitle>
            <CardDescription>
              Pre-fills the Batch modal so a runaway run can't quietly
              drain a wallet. Cache hits cost <code>$0.00</code>, so they
              never count against the cap.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div className="grid gap-2">
              <Label htmlFor="ps-budget">Project budget cap (USD)</Label>
              <Input
                id="ps-budget"
                type="number"
                step="0.0001"
                value={form.budget_usd}
                onChange={(e) => setField("budget_usd", e.target.value)}
                placeholder="(unlimited)"
                disabled={busy}
              />
              <p className="text-[11px] text-muted-foreground">
                Leave empty for "no cap." Pauses new translations once the
                running cost crosses the cap.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">LLM overrides</CardTitle>
            <CardDescription>
              Per-project replacements for the global Settings → LLM
              defaults. Empty fields fall back to the global value, so
              you only need to fill the bits that should differ for this
              book.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ps-llm-url">Base URL</Label>
              <Input
                id="ps-llm-url"
                value={form.llm_base_url}
                onChange={(e) => setField("llm_base_url", e.target.value)}
                placeholder="(use global)"
                disabled={busy}
                spellCheck={false}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="ps-llm-tr">Translator model</Label>
                <Input
                  id="ps-llm-tr"
                  value={form.llm_translator_model}
                  onChange={(e) =>
                    setField("llm_translator_model", e.target.value)
                  }
                  placeholder="(use global)"
                  disabled={busy}
                  spellCheck={false}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ps-llm-he">Helper model</Label>
                <Input
                  id="ps-llm-he"
                  value={form.llm_helper_model}
                  onChange={(e) =>
                    setField("llm_helper_model", e.target.value)
                  }
                  placeholder="(use global)"
                  disabled={busy}
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ps-llm-effort">Reasoning effort</Label>
              <select
                id="ps-llm-effort"
                value={form.llm_reasoning_effort}
                onChange={(e) =>
                  setField(
                    "llm_reasoning_effort",
                    e.target.value as ReasoningEffort,
                  )
                }
                disabled={busy}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">(use global)</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
              <p className="text-[11px] text-muted-foreground">
                Only honored by OpenAI o-series and compatible reasoning
                models; ignored elsewhere.
              </p>
            </div>
          </CardContent>
        </Card>

        <Separator className="opacity-50" />

        <div className="flex justify-end gap-2 pb-2">
          <Button variant="outline" type="button" asChild>
            <Link to={`/project/${projectId}`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={busy} className="gap-2">
            <Save className="size-3.5" />
            {busy ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function clampInt(raw: string, min: number, max: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
