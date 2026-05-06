/**
 * Settings → Ollama options card.
 *
 * Curator-friendly editor for the Ollama-specific runtime options
 * documented in `src/llm/ollama.ts`. The card is *opt-in* — pre-
 * existing curators see no behavioural change until they touch a
 * field.
 *
 * UX contract:
 *
 * 1. Auto-detect whether the configured base URL looks like Ollama
 *    (`:11434`, contains `ollama`). When it doesn't, the card folds
 *    into a muted "Not detected" state behind a one-click reveal so
 *    cloud-only curators don't get distracted by knobs that don't
 *    apply.
 * 2. Surface only the four high-impact knobs (`num_ctx`,
 *    `num_predict`, `temperature`, `repeat_penalty`) by default.
 *    Sampling + Mirostat hide behind a "Show advanced options"
 *    toggle. Every knob carries an inline tooltip with the long
 *    description from `OLLAMA_OPTION_FIELDS`.
 * 3. One-click presets at the top: Translation 8K (recommended),
 *    Long context (16K), Deterministic, Creative. Picking a preset
 *    overwrites the form fields the preset specifies; everything
 *    else stays as the curator left it.
 * 4. "Reset" returns the form to the persisted state. "Clear all"
 *    drops every override (so Ollama uses its built-in defaults
 *    again). Both actions are non-destructive until the curator
 *    clicks Save.
 *
 * The card never sends a partially-typed value to the wire — the
 * provider sanitizes on construction, but rendering also coerces in
 * place so the curator's screen and the eventual payload match.
 */

import * as React from "react";
import { Info, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { FieldHelp } from "@/components/ui/field-help";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/state/app";
import {
  type OllamaOptionField,
  type OllamaOptions,
  OLLAMA_OPTION_FIELDS,
  OLLAMA_PRESETS,
  looksLikeOllamaUrl,
  sanitizeOllamaOptions,
} from "@/llm/ollama";

/**
 * Render one row of the form. Each row owns its own controlled
 * input / select. Empty string ⇒ "no override" (we delete the key
 * from the draft).
 */
interface FieldRowProps {
  field: OllamaOptionField;
  value: number | boolean | undefined;
  onChange(next: number | boolean | undefined): void;
}

export function OllamaOptionsCard(): React.JSX.Element {
  const llm = useAppStore((s) => s.llm);
  const setLlmConfig = useAppStore((s) => s.setLlmConfig);

  // Sanitize once at the boundary so the form never has to think
  // about garbage values from a hand-edited Dexie row.
  const persisted: OllamaOptions = React.useMemo(
    () => sanitizeOllamaOptions(llm.ollama_options ?? null) ?? {},
    [llm.ollama_options],
  );

  const [draft, setDraft] = React.useState<OllamaOptions>(persisted);
  const [show_advanced, setShowAdvanced] = React.useState(false);
  // Curators on cloud endpoints rarely care about Ollama options;
  // the card opens in a compact "not detected" state and they have
  // to click "Show anyway" to see the form. Once expanded, stay
  // expanded for the session — toggling LLM URL during a debug
  // session shouldn't fight the curator.
  const auto_detected = looksLikeOllamaUrl(llm.base_url);
  const [force_show, setForceShow] = React.useState(false);
  const expanded = auto_detected || force_show;

  React.useEffect(() => {
    setDraft(persisted);
  }, [persisted]);

  const dirty = React.useMemo(() => {
    return !shallowOptionsEqual(persisted, draft);
  }, [persisted, draft]);

  const setField = (
    key: keyof OllamaOptions,
    next: number | boolean | undefined,
  ): void => {
    setDraft((cur) => {
      const out = { ...cur } as Record<string, number | boolean | undefined>;
      if (next === undefined) {
        delete out[key];
      } else if (typeof next === "boolean") {
        out[key] = next;
      } else if (Number.isFinite(next)) {
        out[key] = next;
      } else {
        delete out[key];
      }
      return out as OllamaOptions;
    });
  };

  const applyPreset = (preset_id: string): void => {
    const preset = OLLAMA_PRESETS.find((p) => p.id === preset_id);
    if (!preset) return;
    setDraft((cur) => ({ ...cur, ...preset.options }));
    // Surface the preset so the curator knows we just clobbered
    // four fields in one click.
    toast.success(`Loaded preset: ${preset.label}`, {
      description: preset.description,
    });
  };

  const reset = (): void => {
    setDraft(persisted);
  };

  const clearAll = (): void => {
    setDraft({});
  };

  const save = async (): Promise<void> => {
    const sane = sanitizeOllamaOptions(draft);
    await setLlmConfig({ ollama_options: sane });
    toast.success(
      sane && Object.keys(sane).length > 0
        ? `Ollama options saved (${Object.keys(sane).length} override${
            Object.keys(sane).length === 1 ? "" : "s"
          }).`
        : "Ollama options cleared — using model defaults.",
    );
  };

  const common_fields = OLLAMA_OPTION_FIELDS.filter((f) => f.tier === "common");
  const advanced_fields = OLLAMA_OPTION_FIELDS.filter(
    (f) => f.tier === "advanced",
  );
  const override_count = Object.keys(sanitizeOllamaOptions(draft) ?? {}).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Ollama options
          {auto_detected ? (
            <Badge variant="secondary" className="text-[10px] uppercase">
              Detected
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] uppercase">
              Optional
            </Badge>
          )}
          {override_count > 0 ? (
            <Badge variant="secondary" className="ml-auto text-[10px]">
              {override_count} override{override_count === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          Forward Ollama-specific knobs (<code>num_ctx</code>,{" "}
          <code>num_predict</code>, sampling, Mirostat) on every chat
          request. Cloud providers ignore the extra fields, so leaving
          one set won't break a swap to OpenAI / OpenRouter / Together.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!expanded ? (
          <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm">
            <div className="flex items-start gap-3">
              <Info className="mt-0.5 size-4 text-muted-foreground" />
              <div className="grid gap-2">
                <p className="text-muted-foreground">
                  Your base URL doesn't look like an Ollama endpoint
                  (no <code>:11434</code> or <code>ollama</code>). The
                  options below only matter when chatting with Ollama
                  — cloud providers ignore them.
                </p>
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setForceShow(true)}
                  >
                    Show anyway
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
            <PresetRow onApply={applyPreset} />

            <div className="grid gap-4 md:grid-cols-2">
              {common_fields.map((field) => (
                <FieldRow
                  key={field.key}
                  field={field}
                  value={draft[field.key]}
                  onChange={(next) => setField(field.key, next)}
                />
              ))}
            </div>

            <div className="border-t pt-3">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                {show_advanced
                  ? "Hide advanced options"
                  : "Show advanced options (sampling, Mirostat, seed)"}
              </button>
            </div>

            {show_advanced ? (
              <div className="grid gap-4 md:grid-cols-2">
                {advanced_fields.map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    value={draft[field.key]}
                    onChange={(next) => setField(field.key, next)}
                  />
                ))}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => clearAll()}
                className="gap-1.5 text-xs"
                title="Drop every override and let Ollama use its built-in defaults."
              >
                <Trash2 className="size-3.5" /> Clear all
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => reset()}
                disabled={!dirty}
                className="gap-1.5 text-xs"
              >
                <RotateCcw className="size-3.5" /> Reset
              </Button>
              <Button
                type="button"
                onClick={() => void save()}
                disabled={!dirty}
              >
                Save
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PresetRow({
  onApply,
}: {
  onApply(preset_id: string): void;
}): React.JSX.Element {
  return (
    <div className="grid gap-2">
      <Label className="text-xs text-muted-foreground">Quick presets</Label>
      <div className="flex flex-wrap gap-2">
        {OLLAMA_PRESETS.map((preset) => (
          <Tooltip key={preset.id} delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onApply(preset.id)}
                className="rounded-full border bg-background px-3 py-1 text-xs font-medium hover:bg-accent"
              >
                {preset.label}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              {preset.description}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

function FieldRow({ field, value, onChange }: FieldRowProps): React.JSX.Element {
  const id = `ollama_opt_${field.key}`;
  if (field.kind === "boolean") {
    return (
      <BooleanFieldRow
        id={id}
        field={field}
        value={typeof value === "boolean" ? value : undefined}
        onChange={onChange}
      />
    );
  }
  return (
    <NumberFieldRow
      id={id}
      field={field}
      value={typeof value === "number" ? value : undefined}
      onChange={onChange}
    />
  );
}

function NumberFieldRow({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: Extract<OllamaOptionField, { kind: "number" }>;
  value: number | undefined;
  onChange: FieldRowProps["onChange"];
}): React.JSX.Element {
  // Drive the input as a string so partial typing ("8" while typing
  // 8192) doesn't immediately snap to bounds. We coerce on blur and
  // when the curator clicks Save (sanitizer in `setField`).
  const [text, setText] = React.useState<string>(
    value == null ? "" : String(value),
  );

  React.useEffect(() => {
    setText(value == null ? "" : String(value));
  }, [value]);

  const commit = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      onChange(undefined);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      onChange(undefined);
      return;
    }
    onChange(parsed);
  };

  const placeholder =
    field.default_value != null ? String(field.default_value) : "(none)";

  return (
    <div className="grid gap-1.5">
      <FieldHelp
        htmlFor={id}
        label={field.label}
        help={field.long_description}
      />
      {field.enum_values ? (
        <select
          id={id}
          value={value == null ? "" : String(value)}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") onChange(undefined);
            else onChange(Number(v));
          }}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">
            (Ollama default
            {field.default_value != null
              ? `: ${formatNumber(field.default_value)}`
              : ""}
            )
          </option>
          {field.enum_values.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={id}
          type="number"
          inputMode={field.integer ? "numeric" : "decimal"}
          step={field.step}
          min={field.min}
          max={field.max}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          className="font-mono text-xs"
        />
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">
        {field.short_description}
        {field.recommended_value != null &&
        field.recommended_value !== field.default_value ? (
          <>
            {" "}
            <span className="text-foreground/70">
              epublate suggests{" "}
              <code className="font-mono">
                {formatNumber(field.recommended_value)}
              </code>
              .
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}

function BooleanFieldRow({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: Extract<OllamaOptionField, { kind: "boolean" }>;
  value: boolean | undefined;
  onChange: FieldRowProps["onChange"];
}): React.JSX.Element {
  // Tri-state select: "" = no override (use model default), "true" /
  // "false" send the explicit value. Native <select> keeps the form
  // accessible without pulling in a heavier shadcn primitive.
  const stringValue =
    value === undefined ? "" : value ? "true" : "false";
  return (
    <div className="grid gap-1.5">
      <FieldHelp htmlFor={id} label={field.label} help={field.long_description} />
      <select
        id={id}
        value={stringValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") onChange(undefined);
          else onChange(v === "true");
        }}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value="">(use model default)</option>
        <option value="true">true — keep thinking on</option>
        <option value="false">false — disable thinking</option>
      </select>
      <p className="text-[11px] leading-snug text-muted-foreground">
        {field.short_description}
        {field.recommended_value !== null &&
        field.recommended_value !== field.default_value ? (
          <>
            {" "}
            <span className="text-foreground/70">
              epublate suggests{" "}
              <code className="font-mono">
                {String(field.recommended_value)}
              </code>
              .
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}

function formatNumber(n: number): string {
  // Whole numbers shouldn't render as `8192.0`; floats keep two
  // significant digits to fit in tooltip / placeholder text.
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, "");
}

function shallowOptionsEqual(a: OllamaOptions, b: OllamaOptions): boolean {
  const a_keys = Object.keys(a);
  const b_keys = Object.keys(b);
  if (a_keys.length !== b_keys.length) return false;
  const ar = a as Record<string, number | boolean>;
  const br = b as Record<string, number | boolean>;
  for (const key of a_keys) {
    if (ar[key] !== br[key]) return false;
  }
  return true;
}
