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
import { readLlmConfig, writeLlmConfig } from "@/db/library";
import type { LibraryLlmConfigRow } from "@/db/schema";

export type ProjectLlmOverrides = {
  base_url?: string | null;
  translator_model?: string | null;
  helper_model?: string | null;
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | null;
  organization?: string | null;
};

export interface ResolvedLlmConfig {
  base_url: string;
  api_key: string;
  translator_model: string;
  helper_model: string;
  organization: string | null;
  reasoning_effort: "minimal" | "low" | "medium" | "high" | null;
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
  };
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
  });
  return { provider, resolved };
}

/** Convenience for tests / callers that want to seed the library row first. */
export async function ensureLlmConfig(
  patch: Partial<Omit<LibraryLlmConfigRow, "key">>,
): Promise<LibraryLlmConfigRow> {
  return writeLlmConfig(patch);
}
