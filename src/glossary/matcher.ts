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
 */

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
 * Compile an alternation matching any of `terms` with word boundaries.
 *
 * Empty input ⇒ `null` (caller short-circuits). Terms are sorted by
 * length descending so the longest match wins under leftmost-longest
 * semantics in `RegExp.exec`.
 */
export function makePattern(terms: readonly string[]): RegExp | null {
  const cleaned = Array.from(new Set(terms.filter((t) => t.length > 0)));
  if (cleaned.length === 0) return null;
  cleaned.sort((a, b) => (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0));
  const alternation = cleaned.map(reEscape).join("|");
  // Unicode-aware boundaries: `\p{L}` (letter) + `\p{N}` (number) +
  // `_`, mirroring Python's Unicode `\w` semantics.
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`,
    "gu",
  );
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
