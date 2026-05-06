/**
 * Build the active `LLMProvider` from library + per-project state
 * (mirrors `epublate.llm.factory`).
 *
 * Resolution order, on a per-call basis:
 *
 * 1. `mock=true` — pin the deterministic mock provider regardless of
 *    config. This is what the `?mock=1` query string flips for demos
 *    and screenshots.
 * 2. Otherwise build `OpenAICompatProvider` from the library LLM
 *    singleton (Settings screen) merged with the per-project
 *    overrides JSON blob (`project.llm_overrides`). The per-project
 *    override always wins for shared values.
 *
 * Helper-model resolution is the same shape as the Python tool:
 *
 *   override > project_overrides.helper_model > llm.helper_model >
 *   translator_model
 */

import { LLMConfigurationError, type LLMProvider } from "./base";
import { MockProvider } from "./mock";
import { OpenAICompatProvider } from "./openai_compat";
import {
  type OllamaOptions,
  type OllamaOptionsInput,
  sanitizeOllamaOptions,
} from "./ollama";
import { readLlmConfig, writeLlmConfig } from "@/db/library";
import type { LibraryLlmConfigRow } from "@/db/schema";

import type { ProjectEmbeddingOverrides } from "./embeddings/factory";

export type ProjectLlmOverrides = {
  base_url?: string | null;
  translator_model?: string | null;
  helper_model?: string | null;
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | "none" | null;
  organization?: string | null;
  /**
   * Per-project embedding overrides. Lives inside the same
   * `llm_overrides` JSON blob so the existing read/write plumbing
   * works unchanged. `null` ⇒ inherit from the library config.
   */
  embedding?: ProjectEmbeddingOverrides | null;
  /**
   * Per-project Ollama options. Layered onto the library default
   * field-by-field so a project that only wants to bump `num_ctx`
   * doesn't have to re-specify every other knob. `null` keeps the
   * library values; an empty object suppresses them. See
   * `src/llm/ollama.ts`.
   */
  ollama_options?: OllamaOptions | null;
  /** Per-project request timeout override (ms). `null` ⇒ inherit. */
  timeout_ms?: number | null;
};

export interface ResolvedLlmConfig {
  base_url: string;
  api_key: string;
  translator_model: string;
  helper_model: string;
  organization: string | null;
  reasoning_effort: "minimal" | "low" | "medium" | "high" | "none" | null;
  /**
   * Resolved Ollama options. Per-project overrides shallow-merge
   * onto library values so curators can pin one knob (e.g.
   * `num_ctx: 16384`) for a long-form project without forgetting
   * the other defaults. `null` when neither side set anything.
   */
  ollama_options: OllamaOptions | null;
  /**
   * Per-request timeout (ms). `null` means "use the provider's
   * default" (60 s today). New library rows default to 180 s via
   * the Settings card; project overrides can pin a different value
   * for slow local Ollama setups without affecting the global one.
   */
  timeout_ms: number | null;
}

function pickStr(...candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string") {
      const t = c.trim();
      if (t) return t;
    }
  }
  return null;
}

export function resolveLlmConfig(
  library: LibraryLlmConfigRow,
  overrides: ProjectLlmOverrides | null = null,
): ResolvedLlmConfig {
  const base_url = pickStr(overrides?.base_url, library.base_url);
  if (!base_url) {
    throw new LLMConfigurationError(
      "no LLM base_url set — open Settings → LLM and configure an endpoint.",
    );
  }
  const translator_model = pickStr(
    overrides?.translator_model,
    library.model,
  );
  if (!translator_model) {
    throw new LLMConfigurationError(
      "no LLM model set — pick one in Settings → LLM " +
        "(or set a per-project override in the project Settings).",
    );
  }
  const helper_model =
    pickStr(overrides?.helper_model, library.helper_model) ?? translator_model;
  return {
    base_url,
    api_key: library.api_key ?? "",
    translator_model,
    helper_model,
    organization: pickStr(overrides?.organization, library.organization),
    reasoning_effort:
      overrides?.reasoning_effort ?? library.reasoning_effort ?? null,
    ollama_options: mergeOllamaOptions(
      library.ollama_options ?? null,
      overrides?.ollama_options ?? null,
    ),
    timeout_ms: pickPositiveNumber(
      overrides?.timeout_ms,
      library.timeout_ms,
    ),
  };
}

/**
 * Pick the first finite, positive number from a list of candidates.
 * Per-project override wins; library default fills in. Anything
 * non-finite or non-positive (Infinity, 0, NaN, negative numbers,
 * strings…) is treated as "unset" so a corrupt Dexie row can't drop
 * the request timeout to 0 and silently brick every call.
 */
function pickPositiveNumber(
  ...candidates: (number | null | undefined)[]
): number | null {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
  }
  return null;
}

/**
 * Field-by-field merge of two `OllamaOptions`-like blobs.
 * Per-project overrides win on a per-key basis; `undefined` /
 * missing keys fall through to the library default. Returns `null`
 * when the merged result is empty so callers can skip sending the
 * `options` field.
 */
function mergeOllamaOptions(
  library: OllamaOptionsInput | null | undefined,
  override: OllamaOptionsInput | null | undefined,
): OllamaOptions | null {
  const lib = sanitizeOllamaOptions(library ?? null);
  const ovr = sanitizeOllamaOptions(override ?? null);
  if (!lib && !ovr) return null;
  return sanitizeOllamaOptions({ ...(lib ?? {}), ...(ovr ?? {}) });
}

export interface BuildProviderOptions {
  mock?: boolean;
  overrides?: ProjectLlmOverrides | null;
  /** Test seam — bypass the library DB read. */
  configOverride?: LibraryLlmConfigRow;
}

export async function buildProvider(
  options: BuildProviderOptions = {},
): Promise<{ provider: LLMProvider; resolved: ResolvedLlmConfig | null }> {
  if (options.mock) {
    return {
      provider: new MockProvider(),
      resolved: null,
    };
  }
  const cfg = options.configOverride ?? (await readLlmConfig());
  const resolved = resolveLlmConfig(cfg, options.overrides ?? null);
  const provider = new OpenAICompatProvider({
    base_url: resolved.base_url,
    api_key: resolved.api_key,
    default_model: resolved.translator_model,
    organization: resolved.organization ?? undefined,
    reasoning_effort: resolved.reasoning_effort ?? undefined,
    ollama_options: resolved.ollama_options,
    timeout_ms: resolved.timeout_ms ?? undefined,
  });
  return { provider, resolved };
}

/** Convenience for tests / callers that want to seed the library row first. */
export async function ensureLlmConfig(
  patch: Partial<Omit<LibraryLlmConfigRow, "key">>,
): Promise<LibraryLlmConfigRow> {
  return writeLlmConfig(patch);
}
