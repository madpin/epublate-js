/**
 * Project-side glossary embedding helpers — Phase 4.
 *
 * Mirrors `src/lore/embeddings.ts` but for the per-project glossary
 * (`scope = "glossary_entry"` in the project's own embedding store).
 * Used to power the new "proposed terms (unvetted hints)" prompt
 * block: the translator pipeline runs `cosineTopK` against this set
 * to surface only the proposed entries that are semantically
 * relevant to the current segment.
 *
 * Behaviour:
 *
 * - **Best-effort, idempotent**. Any failure (provider down, model
 *   mismatch, transient DB error) is swallowed — embeddings are an
 *   optimization, never a contract. The same entry can be re-embedded
 *   without duplicating rows because `bulkUpsertEmbeddings` uses the
 *   `[scope+ref_id+model]` index as the dedup key.
 * - **Stable text**. `entryEmbeddingText` matches the Lore-Book
 *   shape so an entry promoted from a Lore Book to the project
 *   glossary doesn't drift in vector space.
 * - **Cached provider**. The active `EmbeddingProvider` is resolved
 *   once via `buildEmbeddingProvider` and cached for ~30s so a burst
 *   of glossary writes doesn't re-read the LLM config row each time.
 */

import {
  bulkUpsertEmbeddings,
  deleteEmbeddingsForRef,
  type UpsertEmbeddingInput,
} from "@/db/repo/embeddings";
import { type GlossaryEntryRow } from "@/db/schema";
import { type EmbeddingProvider } from "@/llm/embeddings/base";
import { buildEmbeddingProvider } from "@/llm/embeddings/factory";

/**
 * Canonical embedding text for a project-side glossary entry. Kept
 * intentionally identical to `lore/embeddings.ts` so an entry that
 * moves between scopes lands at the same vector.
 *
 * The status is **excluded** by design: `proposed → confirmed`
 * transitions shouldn't churn the cache. The notes column is the
 * curator's main lever for sense disambiguation, so it's included.
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
export function resetProjectGlossaryEmbeddingProviderCache(): void {
  _cached_provider = null;
  _cached_at = 0;
}

export interface EmbedGlossaryEntriesOptions {
  /** Override the active provider (test seam / batch jobs). */
  provider?: EmbeddingProvider | null;
  /** Abort signal forwarded to the provider. */
  signal?: AbortSignal;
}

/**
 * Embed `entries` and persist them in the project DB under
 * `scope = "glossary_entry"`.
 *
 * Returns the number of vectors written; `0` when embeddings are
 * disabled (no provider configured) or every entry had empty
 * embedding text. Failures bubble only when the caller passes an
 * explicit provider — the public wrapper below swallows them.
 */
export async function embedProjectGlossaryEntriesWithProvider(
  project_id: string,
  entries: readonly GlossaryEntryRow[],
  options: EmbedGlossaryEntriesOptions = {},
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
  const inputs: UpsertEmbeddingInput[] = result.vectors.map((vec, idx) => ({
    scope: "glossary_entry" as const,
    ref_id: refs[idx]!,
    model: provider.model,
    vector: vec,
  }));
  await bulkUpsertEmbeddings("project", project_id, inputs);
  return inputs.length;
}

/**
 * Fire-and-forget embedding write for project glossary entries.
 * Public callers (`createGlossaryEntry`, `updateGlossaryEntry`,
 * `auto_propose`) use this so a transient embedding failure never
 * blocks the actual entry mutation.
 */
export async function embedAndStoreProjectGlossaryEntries(
  project_id: string,
  entries: readonly GlossaryEntryRow[],
): Promise<number> {
  try {
    return await embedProjectGlossaryEntriesWithProvider(project_id, entries);
  } catch {
    return 0;
  }
}

/**
 * Drop every embedding row for a project glossary entry — used when
 * an entry is deleted or merged into another.
 */
export async function deleteProjectGlossaryEntryEmbeddings(
  project_id: string,
  entry_id: string,
): Promise<void> {
  try {
    await deleteEmbeddingsForRef(
      "project",
      project_id,
      "glossary_entry",
      entry_id,
    );
  } catch {
    // Best-effort cleanup.
  }
}
