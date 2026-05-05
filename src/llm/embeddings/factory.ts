/**
 * Build the active `EmbeddingProvider` from library + per-project
 * state (sibling to `@/llm/factory`).
 *
 * Resolution order, on a per-call basis:
 *
 * 1. `mock=true` — pin the deterministic mock provider regardless of
 *    config. Drives the `?mock=1` demo, screenshot pipeline, and
 *    every test.
 * 2. If `library.embedding.provider === "none"` (the default) and no
 *    project override flips it, return `null` — embeddings are
 *    opt-in, so the rest of the codebase falls back to the v1
 *    flatten-everything path.
 * 3. Otherwise build the concrete provider:
 *    - `"openai-compat"` — `OpenAICompatEmbeddingProvider` against
 *      `embedding.base_url` / `embedding.api_key`, falling back to
 *      the LLM endpoint when those are unset.
 *    - `"local"` — `LocalEmbeddingProvider` (`@xenova/transformers`).
 *      Subject to consent (handled inside the provider).
 *
 * Helper-model resolution mirrors `@/llm/factory.resolveLlmConfig`:
 * the per-project override always wins for shared values.
 */

import {
  type EmbeddingProvider,
  EmbeddingConfigurationError,
} from "./base";
import { LocalEmbeddingProvider } from "./local";
import { MockEmbeddingProvider } from "./mock";
import { OpenAICompatEmbeddingProvider } from "./openai_compat";
import { readLlmConfig, writeLlmConfig } from "@/db/library";
import {
  type LibraryEmbeddingConfig,
  type LibraryLlmConfigRow,
  DEFAULT_EMBEDDING_CONFIG,
} from "@/db/schema";

export type ProjectEmbeddingOverrides = {
  /**
   * Per-project provider switch. `null` ⇒ inherit from library.
   * `"none"` lets a project disable embeddings even when the library
   * has a default provider configured.
   */
  provider?: "none" | "openai-compat" | "local" | null;
  model?: string | null;
  dim?: number | null;
  batch_size?: number | null;
  base_url?: string | null;
  api_key?: string | null;
  price_per_mtok?: number | null;
};

export interface ResolvedEmbeddingConfig {
  provider: "openai-compat" | "local";
  model: string;
  dim: number;
  batch_size: number;
  base_url: string | null;
  api_key: string;
  price_per_mtok: number | null;
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

function pickNum(
  ...candidates: (number | null | undefined)[]
): number | null {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
  }
  return null;
}

/**
 * Merge library + project-override into a fully-specified config, or
 * return `null` when embeddings are disabled.
 *
 * Throws `EmbeddingConfigurationError` for inconsistent inputs (e.g.
 * `provider="openai-compat"` without a base_url anywhere).
 */
export function resolveEmbeddingConfig(
  library: LibraryLlmConfigRow,
  overrides: ProjectEmbeddingOverrides | null = null,
): ResolvedEmbeddingConfig | null {
  const lib_emb = library.embedding ?? DEFAULT_EMBEDDING_CONFIG;
  const provider = overrides?.provider ?? lib_emb.provider;
  if (provider === "none") return null;
  if (provider !== "openai-compat" && provider !== "local") {
    throw new EmbeddingConfigurationError(
      `unknown embedding provider "${provider}"`,
    );
  }
  const model =
    pickStr(overrides?.model, lib_emb.model) ?? DEFAULT_EMBEDDING_CONFIG.model;
  const dim =
    pickNum(overrides?.dim, lib_emb.dim) ?? DEFAULT_EMBEDDING_CONFIG.dim;
  const batch_size =
    pickNum(overrides?.batch_size, lib_emb.batch_size) ??
    DEFAULT_EMBEDDING_CONFIG.batch_size;
  const base_url = pickStr(
    overrides?.base_url,
    lib_emb.base_url,
    library.base_url,
  );
  const api_key =
    pickStr(overrides?.api_key, lib_emb.api_key, library.api_key) ?? "";
  const price_per_mtok =
    overrides?.price_per_mtok ?? lib_emb.price_per_mtok ?? null;

  if (provider === "openai-compat" && !base_url) {
    throw new EmbeddingConfigurationError(
      "openai-compat embedding provider needs a base_url — set one in " +
        "Settings → Embeddings or fall back to the main LLM endpoint.",
    );
  }
  return {
    provider,
    model,
    dim,
    batch_size,
    base_url,
    api_key,
    price_per_mtok,
  };
}

export interface BuildEmbeddingProviderOptions {
  mock?: boolean;
  overrides?: ProjectEmbeddingOverrides | null;
  /** Test seam — bypass the library DB read. */
  configOverride?: LibraryLlmConfigRow;
  /**
   * When `false`, the OpenAI-compatible provider will accept any
   * dim returned by the server instead of throwing on a mismatch.
   * The Settings → Embeddings test button passes `false` so a
   * curator probing an unfamiliar model (e.g. Voyage's 1024-dim
   * voyage-3.5) can see the actual dim and update the config.
   * Defaults to `true` so production paths still get the guard.
   */
  validate_dim?: boolean;
}

/**
 * Resolve and instantiate the active embedding provider. Returns
 * `null` (alongside a `null` resolved config) when embeddings are
 * disabled, so call sites can branch with a single `if`.
 */
export async function buildEmbeddingProvider(
  options: BuildEmbeddingProviderOptions = {},
): Promise<{
  provider: EmbeddingProvider | null;
  resolved: ResolvedEmbeddingConfig | null;
}> {
  if (options.mock) {
    return {
      provider: new MockEmbeddingProvider(),
      resolved: null,
    };
  }
  const cfg = options.configOverride ?? (await readLlmConfig());
  const resolved = resolveEmbeddingConfig(cfg, options.overrides ?? null);
  if (!resolved) {
    return { provider: null, resolved: null };
  }
  if (resolved.provider === "openai-compat") {
    return {
      provider: new OpenAICompatEmbeddingProvider({
        base_url: resolved.base_url ?? "",
        api_key: resolved.api_key,
        model: resolved.model,
        dim: resolved.dim,
        batch_size: resolved.batch_size,
        validate_dim: options.validate_dim ?? true,
      }),
      resolved,
    };
  }
  // local
  return {
    provider: new LocalEmbeddingProvider({
      model: resolved.model,
      dim: resolved.dim,
      batch_size: resolved.batch_size,
    }),
    resolved,
  };
}

/** Convenience for tests / callers that want to seed the library row first. */
export async function ensureEmbeddingConfig(
  patch: Partial<LibraryEmbeddingConfig>,
): Promise<LibraryLlmConfigRow> {
  const current = await readLlmConfig();
  const merged: LibraryEmbeddingConfig = {
    ...DEFAULT_EMBEDDING_CONFIG,
    ...(current.embedding ?? {}),
    ...patch,
  };
  return writeLlmConfig({ embedding: merged });
}
