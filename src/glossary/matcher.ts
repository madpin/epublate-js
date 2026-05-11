/**
 * Glossary matcher (mirrors `epublate.glossary.matcher`).
 *
 * Pure functions: every glossary entry mentioned in a source segment,
 * and a check whether a translated target text honored the canonical
 * translation. The pipeline calls this both before the LLM call (to
 * build the constraint list) and after (to validate locked entries —
 * see `enforcer.ts`).
 *
 * Matching strategy:
 *
 * - Canonical source term + every source-side alias. Sort by length
 *   descending so the longer phrase wins ("Saint-Élise" beats "Élise").
 * - Unicode-aware boundary lookarounds (`(?<!\p{L}\p{N}_)` /
 *   `(?!\p{L}\p{N}_)`) instead of `\b` because JS `\b` is ASCII-only.
 * - Case-sensitive by default. Literary fiction distinguishes
 *   "Hope" the character from "hope" the noun.
 * - Overlaps resolved by longest-first/leftmost-wins, mirroring the
 *   regex's default once we feed it a length-sorted alternation.
 *
 * Performance note (the matcher is hot): `makePattern` is called once
 * per glossary entry per segment, both pre-call (constraints) and
 * post-call (validation). For a 2k-term glossary and a long book the
 * compile cost dominates. We memoize compiled patterns at module scope
 * by their deterministic key — the sorted, deduped, NUL-joined term
 * list — with an LRU cap to bound memory. Hits return the same
 * `RegExp` instance; all call sites already reset `lastIndex` before
 * use, which keeps the shared-instance contract correct.
 */

import { Lru } from "@/lib/lru";

import {
  allSourceTerms,
  allTargetTerms,
  type GlossaryEntryWithAliases,
  type Match,
} from "./models";

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

function reEscape(s: string): string {
  return s.replace(ESCAPE_RE, "\\$&");
}

/**
 * LRU-bounded module-scope cache for compiled `makePattern` results.
 *
 * Sized to comfortably hold every entry of a project-wide glossary
 * plus a handful of `targetUses` per-entry compilations. Each value
 * is one `RegExp` object — small but unbounded in count without this
 * cap. The cap is intentionally generous (memory is cheap, recompiles
 * are not) and never grows beyond `MAX_CACHE_SIZE` entries.
 */
const MAX_CACHE_SIZE = 4096;
const patternCache = new Lru<string, RegExp>(MAX_CACHE_SIZE);

/**
 * Compile an alternation matching any of `terms` with word boundaries.
 *
 * Empty input ⇒ `null` (caller short-circuits). Terms are sorted by
 * length descending so the longest match wins under leftmost-longest
 * semantics in `RegExp.exec`.
 *
 * Compiled patterns are cached at module scope keyed by the sorted,
 * deduped term list — repeat calls with the same terms (very common
 * during batch translation, where each glossary entry's pattern is
 * needed twice per segment) return the same `RegExp` instance without
 * paying the `new RegExp(...)` cost. The cache survives across calls
 * but is bounded by `MAX_CACHE_SIZE`.
 *
 * The shared-instance contract: callers MUST reset `lastIndex` before
 * iterating. Every consumer in this codebase already does, but new
 * call sites should follow suit.
 */
export function makePattern(terms: readonly string[]): RegExp | null {
  const cleaned = Array.from(new Set(terms.filter((t) => t.length > 0)));
  if (cleaned.length === 0) return null;
  cleaned.sort((a, b) => (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0));
  // `\u0000` is forbidden in JS source / regex literals we'd ever
  // care about, and impossible to collide with normal glossary text.
  const cacheKey = cleaned.join("\u0000");
  const cached = patternCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const alternation = cleaned.map(reEscape).join("|");
  // Unicode-aware boundaries: `\p{L}` (letter) + `\p{N}` (number) +
  // `_`, mirroring Python's Unicode `\w` semantics.
  const compiled = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`,
    "gu",
  );
  patternCache.set(cacheKey, compiled);
  return compiled;
}

/**
 * Read-only counters surfaced for benchmark tests. `compile_count`
 * grows when a new `RegExp` is constructed (i.e. a cache miss);
 * `cache_hit_count` grows when an existing one is reused. Production
 * code must not depend on these for correctness — they are observation
 * only.
 */
export interface MatcherStats {
  compile_count: number;
  cache_hit_count: number;
  cache_size: number;
}

export function __getMatcherStats(): MatcherStats {
  const s = patternCache.stats();
  return {
    compile_count: s.misses,
    cache_hit_count: s.hits,
    cache_size: s.size,
  };
}

/**
 * Reset the cache + counters. Intended for tests that need a clean
 * slate when asserting compile counts. Not exposed as a public API —
 * normal usage never needs to flush.
 */
export function __resetMatcherCacheForTests(): void {
  patternCache.clear();
}

/**
 * Find every glossary mention in `sourceText`.
 *
 * Returns matches in the order they appear in the source. An entry
 * that matches multiple times yields one Match per occurrence so the
 * validator and cascade can quote precise spans.
 */
export function matchSource(
  sourceText: string,
  entries: Iterable<GlossaryEntryWithAliases>,
): Match[] {
  const matches: Match[] = [];
  for (const ent of entries) {
    const pattern = makePattern(allSourceTerms(ent));
    if (pattern === null) continue;
    let m: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(sourceText)) !== null) {
      matches.push({
        entry_id: ent.entry.id,
        term: m[0],
        start: m.index,
        end: m.index + m[0].length,
      });
      if (m[0].length === 0) pattern.lastIndex++;
    }
  }
  matches.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return a.end - b.end;
    return a.entry_id < b.entry_id ? -1 : a.entry_id > b.entry_id ? 1 : 0;
  });
  return matches;
}

/**
 * Return `true` iff `targetText` contains `entry`'s target term.
 *
 * If `acceptAliases` is set, target-side aliases also satisfy the
 * check. Lookups use the same word-boundary regex as the source
 * matcher so `"Eli"` does not satisfy a target term `"Elisa"`.
 */
export function targetUses(
  targetText: string,
  entry: GlossaryEntryWithAliases,
  opts: { accept_aliases?: boolean } = {},
): boolean {
  const acceptAliases = opts.accept_aliases ?? true;
  const candidates = acceptAliases ? allTargetTerms(entry) : [entry.entry.target_term];
  const pattern = makePattern(candidates);
  if (pattern === null) return false;
  pattern.lastIndex = 0;
  return pattern.exec(targetText) !== null;
}
