import * as React from "react";
import { toast } from "sonner";
import {
  DollarSign,
  Eye,
  EyeOff,
  Loader2,
  PlugZap,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";

import { OpenAICompatProvider } from "@/llm/openai_compat";
import {
  type ModelPrice,
  hasPrice,
  listDefaultPricing,
  listEffectivePricing,
} from "@/llm/pricing";
import { useAppStore } from "@/state/app";
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

/**
 * Settings screen.
 *
 * P0 wires the LLM endpoint config + theme + mock toggle so any later
 * phase can read `useAppStore.getState().llm` and immediately work.
 * The full settings surface (budget caps, helper model, retention)
 * lands in P6.
 */
export function SettingsRoute(): React.JSX.Element {
  const llm = useAppStore((s) => s.llm);
  const ui = useAppStore((s) => s.ui);
  const setLlmConfig = useAppStore((s) => s.setLlmConfig);
  const setUiPref = useAppStore((s) => s.setUiPref);
  const mock_mode = useAppStore((s) => s.mock_mode);
  const setMockMode = useAppStore((s) => s.setMockMode);

  const [base_url, setBaseUrl] = React.useState(llm.base_url);
  const [api_key, setApiKey] = React.useState(llm.api_key);
  const [model, setModel] = React.useState(llm.model);
  const [helper_model, setHelperModel] = React.useState(llm.helper_model ?? "");
  const [reasoning_effort, setReasoningEffort] = React.useState<
    "" | "minimal" | "low" | "medium" | "high"
  >(llm.reasoning_effort ?? "");
  const [show_key, setShowKey] = React.useState(false);

  const [budget_default, setBudgetDefault] = React.useState(
    ui.default_budget_usd != null ? String(ui.default_budget_usd) : "",
  );
  const [concurrency_default, setConcurrencyDefault] = React.useState(
    String(ui.default_concurrency ?? 4),
  );

  React.useEffect(() => {
    setBaseUrl(llm.base_url);
    setApiKey(llm.api_key);
    setModel(llm.model);
    setHelperModel(llm.helper_model ?? "");
    setReasoningEffort(llm.reasoning_effort ?? "");
  }, [llm]);

  React.useEffect(() => {
    setBudgetDefault(
      ui.default_budget_usd != null ? String(ui.default_budget_usd) : "",
    );
    setConcurrencyDefault(String(ui.default_concurrency ?? 4));
  }, [ui]);

  const [testing, setTesting] = React.useState(false);

  const save = async (): Promise<void> => {
    // Trim aggressively — a copy-pasted API key with a trailing
    // newline produces an `Authorization: Bearer sk-…\n` header that
    // the browser rejects synchronously with `TypeError: Failed to
    // execute 'fetch'`, which surfaces as a confusing "network error"
    // before the request ever leaves the page.
    const trimmed_key = api_key.trim();
    setApiKey(trimmed_key);
    await setLlmConfig({
      base_url: base_url.trim(),
      api_key: trimmed_key,
      model: model.trim(),
      helper_model: helper_model.trim() || null,
      reasoning_effort: reasoning_effort === "" ? null : reasoning_effort,
    });
    toast.success("LLM config saved.");
  };

  const testConnection = async (): Promise<void> => {
    const url = base_url.trim();
    const key = api_key.trim();
    const m = model.trim();
    if (!url) {
      toast.error("Set a base URL first.");
      return;
    }
    if (!m) {
      toast.error("Set a translator model first.");
      return;
    }
    setApiKey(key);
    setTesting(true);
    try {
      const provider = new OpenAICompatProvider({
        base_url: url,
        api_key: key || undefined,
        default_model: m,
        timeout_ms: 20_000,
        retry_policy: { max_retries: 0 },
      });
      const t0 = performance.now();
      const result = await provider.chat({
        model: m,
        messages: [
          {
            role: "user",
            content: "Reply with the single word: ok",
          },
        ],
        temperature: 0,
      });
      const dt = Math.round(performance.now() - t0);
      const preview = result.content.trim().slice(0, 40) || "(empty)";
      toast.success(
        `Connected to ${url} via ${result.model} in ${dt} ms — “${preview}”`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Connection failed: ${msg}`, { duration: 12_000 });
    } finally {
      setTesting(false);
    }
  };

  const saveDefaults = async (): Promise<void> => {
    const budget_n =
      budget_default.trim() === "" ? null : Number(budget_default);
    const conc_n = Math.max(
      1,
      Math.min(8, Number(concurrency_default) || 4),
    );
    await setUiPref(
      "default_budget_usd",
      budget_n !== null && Number.isFinite(budget_n) ? budget_n : null,
    );
    await setUiPref("default_concurrency", conc_n);
    toast.success("Defaults saved.");
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          All values are stored in your browser only. No telemetry, no
          server calls outside the configured LLM endpoint.
        </p>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
        <Card>
          <CardHeader>
            <CardTitle>LLM endpoint</CardTitle>
            <CardDescription>
              OpenAI-compatible: OpenAI, OpenRouter, Together, Groq, …. Local
              Ollama works after setting <code>OLLAMA_ORIGINS=*</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="base_url">Base URL</Label>
              <Input
                id="base_url"
                value={base_url}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="api_key">API key</Label>
              <div className="flex gap-2">
                <Input
                  id="api_key"
                  type={show_key ? "text" : "password"}
                  value={api_key}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-…"
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={show_key ? "Hide key" : "Show key"}
                >
                  {show_key ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="model">Translator model</Label>
                <Input
                  id="model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="gpt-5-mini"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="helper_model">Helper model (optional)</Label>
                <Input
                  id="helper_model"
                  value={helper_model}
                  onChange={(e) => setHelperModel(e.target.value)}
                  placeholder="gpt-5-nano"
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="reasoning_effort">
                Reasoning effort (OpenAI o-series; ignored elsewhere)
              </Label>
              <select
                id="reasoning_effort"
                value={reasoning_effort}
                onChange={(e) =>
                  setReasoningEffort(
                    e.target.value as
                      | ""
                      | "minimal"
                      | "low"
                      | "medium"
                      | "high",
                  )
                }
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">(provider default)</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => void testConnection()}
                disabled={testing}
                className="gap-2"
                title="Send one short prompt to confirm the URL, key, and model all work."
              >
                {testing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <PlugZap className="size-4" />
                )}
                {testing ? "Testing…" : "Test connection"}
              </Button>
              <Button onClick={() => void save()}>Save</Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Defaults</CardTitle>
            <CardDescription>
              Pre-fills the Batch modal so you don't have to set the same
              values for every project.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="budget_default">
                  Default budget cap (USD)
                </Label>
                <Input
                  id="budget_default"
                  type="number"
                  step="0.0001"
                  value={budget_default}
                  onChange={(e) => setBudgetDefault(e.target.value)}
                  placeholder="(unlimited)"
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to run without a cap. Pauses new work once
                  cumulative cost crosses the cap.
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="concurrency_default">
                  Default concurrency
                </Label>
                <Input
                  id="concurrency_default"
                  type="number"
                  min={1}
                  max={8}
                  value={concurrency_default}
                  onChange={(e) => setConcurrencyDefault(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Parallel translator calls. Most public endpoints
                  tolerate 4; OpenRouter/Together cope with more.
                </p>
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => void saveDefaults()}>
                Save defaults
              </Button>
            </div>
          </CardContent>
        </Card>

        <PricingCard />

        <Card>
          <CardHeader>
            <CardTitle>Behavior</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ToggleRow
              label="Mock LLM"
              description="Use the deterministic mock provider — no network. Useful for offline demos and tests."
              checked={mock_mode}
              onCheckedChange={setMockMode}
            />
            <Separator />
            <ToggleRow
              label="Auto tone-sniff on new project"
              description="Run the helper LLM once at project creation to suggest a style profile."
              checked={ui.auto_tone_sniff}
              onCheckedChange={(v) => void setUiPref("auto_tone_sniff", v)}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * Pricing card — lists the active default rates and lets the curator
 * override a model's price (or add a custom one). Persisted in the
 * library DB so the price meter stays accurate across reloads.
 *
 * "Why is my cost meter $0.0000?" usually means the curator's model
 * isn't in the default table (e.g. a LiteLLM proxy slug like
 * `deepseek-v4-flash`). Adding an override here fixes that without
 * touching code.
 */
function PricingCard(): React.JSX.Element {
  const llm = useAppStore((s) => s.llm);
  const setLlmConfig = useAppStore((s) => s.setLlmConfig);

  const overrides = llm.pricing_overrides ?? {};

  const [draft_model, setDraftModel] = React.useState(llm.model || "");
  const [draft_input, setDraftInput] = React.useState("");
  const [draft_output, setDraftOutput] = React.useState("");

  // Re-suggest the current translator slug whenever the LLM config
  // changes, so the curator can override an unknown model with two
  // clicks (open Settings → punch in input/output prices → Add).
  React.useEffect(() => {
    setDraftModel((cur) => (cur ? cur : llm.model || ""));
  }, [llm.model]);

  const defaults = React.useMemo(() => listDefaultPricing(), []);
  // Re-snapshot the table on every render so an Add/Remove repaints
  // immediately. The table is a tiny in-memory object — cheap.
  const effective = listEffectivePricing();
  const sorted_models = React.useMemo(
    () =>
      Object.keys(effective).sort((a, b) => {
        const a_override = a in overrides ? 0 : 1;
        const b_override = b in overrides ? 0 : 1;
        if (a_override !== b_override) return a_override - b_override;
        return a.localeCompare(b);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overrides, JSON.stringify(effective)],
  );

  const current_model_priced = hasPrice(llm.model);

  const addOverride = async (): Promise<void> => {
    const slug = draft_model.trim();
    const i = Number(draft_input);
    const o = Number(draft_output);
    if (!slug) {
      toast.error("Pick a model slug.");
      return;
    }
    if (!Number.isFinite(i) || i < 0 || !Number.isFinite(o) || o < 0) {
      toast.error("Prices must be non-negative numbers (USD per Mtok).");
      return;
    }
    const next = { ...overrides, [slug]: { input_per_mtok: i, output_per_mtok: o } };
    await setLlmConfig({ pricing_overrides: next });
    setDraftModel("");
    setDraftInput("");
    setDraftOutput("");
    toast.success(`Pricing saved for ${slug}.`);
  };

  const removeOverride = async (slug: string): Promise<void> => {
    if (!(slug in overrides)) return;
    const next = { ...overrides };
    delete next[slug];
    await setLlmConfig({ pricing_overrides: next });
    toast.success(`Removed override for ${slug}.`);
  };

  const editOverride = (slug: string): void => {
    const price = overrides[slug] ?? defaults[slug];
    if (!price) return;
    setDraftModel(slug);
    setDraftInput(String(price.input_per_mtok));
    setDraftOutput(String(price.output_per_mtok));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="size-4 text-primary" /> Pricing
        </CardTitle>
        <CardDescription>
          USD per million tokens. Used by the cost meter, batch budget
          cap, and audit log. Unknown models bill at zero — add an
          override here so the meter stays accurate.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!current_model_priced && llm.model.trim() ? (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
            <span className="font-medium">
              Heads-up: <code className="font-mono">{llm.model}</code> has
              no pricing entry — translations will record{" "}
              <code className="font-mono">$0.00</code>.
            </span>{" "}
            Set the rate below so the cost meter reflects real spend.
          </div>
        ) : null}
        <div className="grid gap-3 md:grid-cols-[1.5fr_repeat(2,1fr)_auto]">
          <div className="grid gap-1.5">
            <Label htmlFor="price-model" className="text-xs">
              Model slug
            </Label>
            <Input
              id="price-model"
              value={draft_model}
              onChange={(e) => setDraftModel(e.target.value)}
              placeholder="deepseek-v4-flash"
              className="font-mono text-xs"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="price-input" className="text-xs">
              Input $/Mtok
            </Label>
            <Input
              id="price-input"
              type="number"
              step="0.0001"
              min={0}
              value={draft_input}
              onChange={(e) => setDraftInput(e.target.value)}
              placeholder="0.27"
              className="font-mono text-xs"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="price-output" className="text-xs">
              Output $/Mtok
            </Label>
            <Input
              id="price-output"
              type="number"
              step="0.0001"
              min={0}
              value={draft_output}
              onChange={(e) => setDraftOutput(e.target.value)}
              placeholder="1.10"
              className="font-mono text-xs"
            />
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              onClick={() => void addOverride()}
              className="w-full gap-1.5 md:w-auto"
            >
              <Plus className="size-3.5" />
              {overrides[draft_model.trim()] ? "Update" : "Save"}
            </Button>
          </div>
        </div>
        <div className="rounded-md border">
          <div className="grid grid-cols-[1.4fr_1fr_1fr_auto] gap-2 border-b bg-muted/30 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <div>Model</div>
            <div className="text-right">Input</div>
            <div className="text-right">Output</div>
            <div className="w-16 text-right">Source</div>
          </div>
          <ul className="max-h-72 divide-y overflow-y-auto">
            {sorted_models.length === 0 ? (
              <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                No pricing rows.
              </li>
            ) : (
              sorted_models.map((slug) => {
                const price = effective[slug] as ModelPrice | undefined;
                if (!price) return null;
                const is_override = slug in overrides;
                return (
                  <li
                    key={slug}
                    className="grid grid-cols-[1.4fr_1fr_1fr_auto] items-center gap-2 px-3 py-1.5 text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => editOverride(slug)}
                      className="truncate text-left font-mono text-[11px] hover:underline"
                      title={`Click to edit ${slug}`}
                    >
                      {slug}
                    </button>
                    <div className="text-right font-mono">
                      ${price.input_per_mtok.toFixed(4)}
                    </div>
                    <div className="text-right font-mono">
                      ${price.output_per_mtok.toFixed(4)}
                    </div>
                    <div className="flex w-16 justify-end gap-1">
                      {is_override ? (
                        <>
                          <Badge variant="outline" className="text-[9px]">
                            custom
                          </Badge>
                          <button
                            type="button"
                            onClick={() => void removeOverride(slug)}
                            aria-label={`Remove override for ${slug}`}
                            className="rounded p-1 hover:bg-accent"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </>
                      ) : (
                        <Badge variant="secondary" className="text-[9px]">
                          default
                        </Badge>
                      )}
                    </div>
                  </li>
                );
              })
            )}
          </ul>
        </div>
        {Object.keys(overrides).length > 0 ? (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={async () => {
                await setLlmConfig({ pricing_overrides: {} });
                toast.success("All pricing overrides cleared.");
              }}
              className="gap-1.5 text-xs text-muted-foreground"
            >
              <RotateCcw className="size-3" /> Clear all overrides
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange(v: boolean): void;
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onCheckedChange(e.target.checked)}
        className="mt-1 size-4 accent-primary"
      />
    </label>
  );
}
