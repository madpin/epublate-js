/**
 * Build-time `.env` defaults for the LLM Settings card.
 *
 * `epublatejs` is a static SPA — there is no server. Anything we read
 * here is captured by Vite **at build time** as a string literal and
 * baked into the resulting JS bundle. That has two implications:
 *
 *   1. `.env` is a *first-run convenience*, not a runtime override.
 *      Curators who have already configured the LLM in Settings will
 *      never see env values; the persisted Dexie row always wins. See
 *      `state/app.ts → hydrate()` for the seeding rule (write only
 *      when the row is genuinely empty).
 *
 *   2. `VITE_EPUBLATE_LLM_API_KEY` ends up in any deployed bundle. For
 *      local development against a private endpoint this is fine; for
 *      a public deploy it is a credential leak. The `.env.example`
 *      file is the canonical place this warning lives.
 *
 * The helpers in this file stay pure (no Dexie, no React) so the seed
 * logic in `state/app.ts` and the preset buttons in `SettingsRoute`
 * can compose them without dragging in a runtime context.
 */

import type { LibraryLlmConfigRow } from "@/db/schema";

/**
 * Subset of `LibraryLlmConfigRow` keys that the `.env` layer can
 * pre-fill. Other fields (pricing overrides, batch_retry, …) stay
 * curator-only — they're not the kind of value a setup script should
 * be guessing.
 */
export type LlmEnvDefaults = Partial<
  Pick<
    LibraryLlmConfigRow,
    | "base_url"
    | "api_key"
    | "model"
    | "helper_model"
    | "organization"
    | "reasoning_effort"
    | "timeout_ms"
  >
>;

/**
 * Allowed reasoning-effort values. Mirrors the `LibraryLlmConfigRow`
 * union so a typo in `.env` is dropped silently rather than poisoning
 * the Dexie row.
 */
const REASONING_EFFORT_VALUES = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "none",
]);

/**
 * Read the build-time env defaults. Accepts an explicit source map so
 * tests can pass a synthetic record without trying to mock
 * `import.meta.env` (which Vite captures statically).
 *
 * Returns a *partial* shape — keys for which the env var was unset
 * or unparseable are simply absent so the caller can spread it onto a
 * default config without nulling fields it didn't intend to set.
 */
export function readLlmEnvDefaults(
  source: Readonly<Record<string, string | undefined>> = (
    typeof import.meta !== "undefined" && import.meta.env
      ? (import.meta.env as unknown as Record<string, string | undefined>)
      : {}
  ),
): LlmEnvDefaults {
  const out: LlmEnvDefaults = {};

  const base_url = pickString(source.VITE_EPUBLATE_LLM_BASE_URL);
  if (base_url !== null) out.base_url = base_url;

  const api_key = pickString(source.VITE_EPUBLATE_LLM_API_KEY);
  if (api_key !== null) out.api_key = api_key;

  const model = pickString(source.VITE_EPUBLATE_LLM_MODEL);
  if (model !== null) out.model = model;

  const helper_model = pickString(source.VITE_EPUBLATE_LLM_HELPER_MODEL);
  if (helper_model !== null) out.helper_model = helper_model;

  const organization = pickString(source.VITE_EPUBLATE_LLM_ORGANIZATION);
  if (organization !== null) out.organization = organization;

  const reasoning_effort = pickString(
    source.VITE_EPUBLATE_LLM_REASONING_EFFORT,
  );
  if (reasoning_effort !== null && REASONING_EFFORT_VALUES.has(reasoning_effort)) {
    out.reasoning_effort = reasoning_effort as LlmEnvDefaults["reasoning_effort"];
  }

  const timeout_ms = pickPositiveInt(source.VITE_EPUBLATE_LLM_TIMEOUT_MS);
  if (timeout_ms !== null) out.timeout_ms = timeout_ms;

  return out;
}

/**
 * True when at least one supported `VITE_EPUBLATE_LLM_*` var is set
 * to a non-empty value. Used by `state/app.ts` to decide whether to
 * surface a "loaded defaults from .env" toast on first hydrate.
 */
export function hasLlmEnvDefaults(defaults: LlmEnvDefaults): boolean {
  return Object.keys(defaults).length > 0;
}

function pickString(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed;
}

function pickPositiveInt(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return Math.round(n);
}

// ---------- Quick presets for the Settings card ----------

/**
 * UI-only preset shape used by the LLM Settings card's "Quick
 * presets" row. Three flavours cover the bulk of curator setups:
 *
 *   - **OpenAI** — the canonical hosted endpoint.
 *   - **OpenRouter** — a multi-model gateway with the same
 *     OpenAI-compat surface. Model slugs are namespaced
 *     (`<vendor>/<model>`).
 *   - **Ollama** — local-only, OpenAI-compat surface on
 *     `localhost:11434/v1`. No key needed; remember to start Ollama
 *     with the multi-scheme `OLLAMA_ORIGINS` allow-list so the
 *     `https://` page origin (Vercel preview / installed PWA) isn't
 *     rejected by its CORS layer.
 *
 * Pure data — no Dexie writes happen until the curator clicks Save in
 * the LLM card, exactly like every other field on that screen. Preset
 * buttons never touch the API key field; that's a separate decision
 * the curator owns.
 */
export interface LlmPreset {
  id: "openai" | "openrouter" | "ollama";
  label: string;
  base_url: string;
  model: string;
  /** Optional helper-model slug to suggest alongside the translator. */
  helper_model?: string;
  /** One-line tooltip explaining what's special about this provider. */
  hint: string;
}

export const LLM_PRESETS: readonly LlmPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    base_url: "https://api.openai.com/v1",
    model: "gpt-5-mini",
    helper_model: "gpt-5-nano",
    hint:
      "Hosted OpenAI endpoint. Paste your `sk-…` key into the API key field after picking this preset.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    base_url: "https://openrouter.ai/api/v1",
    model: "openai/gpt-5-mini",
    helper_model: "openai/gpt-5-nano",
    hint:
      "Multi-model gateway. Model slugs are namespaced as `<vendor>/<model>`. Browse the catalogue at openrouter.ai/models.",
  },
  {
    id: "ollama",
    label: "Ollama",
    base_url: "http://localhost:11434/v1",
    model: "llama3.2",
    hint:
      'Local-only. Start Ollama with `OLLAMA_ORIGINS="http://*,https://*,chrome-extension://*,moz-extension://*"` and pull a model first. No API key needed.',
  },
] as const;

/** Convenience lookup so callers can fetch a preset by `id`. */
export function findLlmPreset(id: LlmPreset["id"]): LlmPreset | undefined {
  return LLM_PRESETS.find((p) => p.id === id);
}
