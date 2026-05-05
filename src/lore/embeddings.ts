/**
 * Lore-Book embedding helpers.
 *
 * Bridges Lore-Book glossary writes to the embedding provider so the
 * retrieval layer (`resolveProjectGlossaryWithLore` + Phase 4 proposed
 * hints) can rank entries by semantic similarity to the segment being
 * translated.
 *
 * Design notes:
 *
 * - The functions here are best-effort. A failure to embed must not
 *   block the curator from creating a Lore-Book entry — embeddings
 *   are an optimization, not a contract.
 * - We resolve the active provider once via `buildEmbeddingProvider`.
 *   When `provider="none"` (the default), the call short-circuits to
 *   a no-op. Tests in `?mock=1` mode resolve the mock provider, which
 *   means snapshots stay stable.
 * - Embedding text is the canonical "source — target — notes" string
 *   so the dedup phase (Phase 5) can compare project-side glossary
 *   entries against Lore-Book entries with the same encoder.
 *
 * The entry point used by the rest of the code:
 *
 * - `embedAndStoreLoreEntries(lore_id, entries)` — fire-and-forget
 *   from `createLoreEntry` / `updateLoreEntry`. Idempotent on
 *   `(scope, ref_id, model)` so re-runs are safe.
 */

import { type GlossaryEntryRow } from "@/db/schema";
import { upsertEmbedding } from "@/db/repo/embeddings";
import { buildEmbeddingProvider } from "@/llm/embeddings/factory";
import { type EmbeddingProvider } from "@/llm/embeddings/base";

/**
 * Canonical embedding text for a glossary entry. Kept stable so the
 * cache key stays the same when peripheral fields shift (gender /
 * status). Status is what changes most often; rejecting it here
 * means a "proposed → confirmed" transition doesn't trigger a
 * re-embed — the same vector applies.
 */
export function entryEmbeddingText(entry: GlossaryEntryRow): string {
  const parts: string[] = [];
  if (entry.source_term) parts.push(entry.source_term);
  parts.push(entry.target_term);
  if (entry.notes && entry.notes.trim()) parts.push(entry.notes.trim());
  return parts.join(" — ");
}

let _cached_provider: { provider: EmbeddingProvider | null } | null = null;
let _cached_at = 0;
const PROVIDER_CACHE_TTL_MS = 30_000;

/**
 * Resolve the active embedding provider with a tiny TTL cache.
 *
 * The Settings card writes the LLM config row when curators flip
 * providers; the cache is here so a rapid sequence of `createLoreEntry`
 * calls doesn't re-read the singleton row each time.
 */
async function activeEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  const now = Date.now();
  if (_cached_provider && now - _cached_at < PROVIDER_CACHE_TTL_MS) {
    return _cached_provider.provider;
  }
  try {
    const result = await buildEmbeddingProvider();
    _cached_provider = { provider: result.provider };
    _cached_at = now;
    return result.provider;
  } catch {
    _cached_provider = { provider: null };
    _cached_at = now;
    return null;
  }
}

/** Test seam — resets the provider cache so a config-flip is picked up. */
export function resetEmbeddingProviderCache(): void {
  _cached_provider = null;
  _cached_at = 0;
}

export interface EmbedLoreEntriesOptions {
  /** Override the active provider (test seam / batch jobs). */
  provider?: EmbeddingProvider | null;
  /** Abort signal forwarded to the provider. */
  signal?: AbortSignal;
}

/**
 * Embed the given entries and persist them in the Lore Book's per-DB
 * `embeddings` table under `scope="glossary_entry"`. Returns the
 * number of vectors written; `0` when embeddings are disabled or all
 * entries had empty embedding text.
 *
 * Failures bubble out only when the caller passes an explicit
 * provider; the public `embedAndStoreLoreEntries` wrapper swallows
 * them so write paths never break.
 */
export async function embedLoreEntriesWithProvider(
  lore_id: string,
  entries: readonly GlossaryEntryRow[],
  options: EmbedLoreEntriesOptions = {},
): Promise<number> {
  const provider = options.provider ?? (await activeEmbeddingProvider());
  if (!provider) return 0;
  const texts: string[] = [];
  const refs: string[] = [];
  for (const entry of entries) {
    const text = entryEmbeddingText(entry);
    if (!text) continue;
    texts.push(text);
    refs.push(entry.id);
  }
  if (!texts.length) return 0;
  const result = await provider.embed(texts, options.signal);
  const inputs = result.vectors.map((vec, idx) => ({
    scope: "glossary_entry" as const,
    ref_id: refs[idx]!,
    model: provider.model,
    vector: vec,
  }));
  for (const input of inputs) {
    await upsertEmbedding("lore", lore_id, input);
  }
  return inputs.length;
}

/**
 * Fire-and-forget embedding write. Public callers (Lore Book glossary
 * repo, ingest helpers) use this so a transient embedding failure
 * never blocks the actual entry mutation.
 */
export async function embedAndStoreLoreEntries(
  lore_id: string,
  entries: readonly GlossaryEntryRow[],
): Promise<number> {
  try {
    return await embedLoreEntriesWithProvider(lore_id, entries);
  } catch {
    return 0;
  }
}
