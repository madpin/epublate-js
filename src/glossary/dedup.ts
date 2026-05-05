/**
 * Near-duplicate glossary entry detection
 * (mirrors `epublate.glossary.dedup`).
 *
 * The auto-proposer used to dedupe by exact `source_term`; that lets
 * near-misses past:
 * - "Heavily Indebted Poor Country (HIPC)" vs the same + " initiative",
 * - "FIFA" vs "(FIFA" with a broken paren,
 * - "House Lannister" vs "house lannister".
 *
 * `upsertProposed` (`io.ts`) prevents *new* near-duplicates by
 * canonicalising before lookup. This module is the **cleanup** half:
 * given a project's existing entries, return groups of near-duplicates
 * the curator should review.
 *
 * Two-stage matching:
 * 1. Canonical-form bucketing — `canonicalForm` strips case, trailing
 *    punctuation, parenthesised acronym suffixes, and a small list of
 *    common-noun suffixes ("initiative", "council", "company", …).
 * 2. Levenshtein guard for residuals — entries whose canonical forms
 *    aren't equal but are within 2 edits and share a 3+ character
 *    prefix get merged into the same group.
 */

import type { GlossaryEntryWithAliases } from "./models";

const TRAILING_NOUN_SUFFIXES: readonly string[] = [
  "initiative",
  "initiatives",
  "program",
  "programs",
  "programme",
  "programmes",
  "council",
  "committee",
  "council of",
  "society",
  "association",
  "organization",
  "organisation",
  "company",
  "corporation",
  "incorporated",
  "limited",
];

function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TRAILING_NOUN_RE = new RegExp(
  `\\s+(?:${TRAILING_NOUN_SUFFIXES.map(reEscape).join("|")})$`,
  "iu",
);

const PAREN_ACRONYM_RE = /\s*\([^()]*\)\s*$|\s*\([^()]*$/u;

const TRAILING_PUNCT = ".,;:!?·-\u2026\u2014\u2013";

function rstripPunct(s: string): string {
  let end = s.length;
  while (end > 0 && TRAILING_PUNCT.includes(s[end - 1]!)) end--;
  return s.slice(0, end);
}

/**
 * Return the canonical comparison form for `term`.
 *
 * Steps in order: NFKC normalize, lowercase, strip leading/trailing
 * whitespace, strip a trailing punctuation run, collapse internal
 * whitespace, then repeatedly strip trailing common-noun suffixes
 * and parenthesised acronym suffixes until fixed-point. Returns ""
 * when nothing meaningful is left.
 */
export function canonicalForm(term: string): string {
  if (!term) return "";
  let text = term.normalize("NFKC").trim().toLowerCase();
  text = rstripPunct(text).trim();
  text = text.replace(/\s+/gu, " ");
  for (let i = 0; i < 4; i++) {
    const before = text;
    text = text.replace(TRAILING_NOUN_RE, "").trim();
    text = text.replace(PAREN_ACRONYM_RE, "").trim();
    if (text === before) break;
  }
  return rstripPunct(text).trim();
}

/**
 * Bounded Levenshtein distance.
 *
 * Returns `cap` immediately if the two strings differ in length by
 * more than `cap`; otherwise computes the standard edit distance
 * with row-min short-circuiting.
 */
function levenshtein(a: string, b: string, cap: number = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) >= cap) return cap;
  if (a.length > b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }
  const aLen = a.length;
  const bLen = b.length;
  let previous = new Array<number>(aLen + 1);
  for (let i = 0; i <= aLen; i++) previous[i] = i;
  for (let j = 1; j <= bLen; j++) {
    const cb = b.charCodeAt(j - 1);
    const current = new Array<number>(aLen + 1);
    current[0] = j;
    let rowMin = j;
    for (let i = 1; i <= aLen; i++) {
      const insert = current[i - 1]! + 1;
      const del = previous[i]! + 1;
      const sub = previous[i - 1]! + (a.charCodeAt(i - 1) === cb ? 0 : 1);
      let value = insert;
      if (del < value) value = del;
      if (sub < value) value = sub;
      current[i] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin >= cap) return cap;
    previous = current;
  }
  return Math.min(previous[aLen]!, cap);
}

function keySide(entry: GlossaryEntryWithAliases): string {
  if (entry.entry.source_term) return canonicalForm(entry.entry.source_term);
  return canonicalForm(entry.entry.target_term);
}

/**
 * Group `entries` by canonical form + a Levenshtein guard.
 *
 * Returns one list per duplicate group, each sorted with the "winner"
 * first using the same criteria as the Python repo:
 * - status priority (locked > confirmed > proposed),
 * - specific type over generic `term`,
 * - older entry first as tiebreaker.
 *
 * Singletons (canonical bucket of size 1 with no fuzzy neighbour) are
 * omitted. Group order is stable: sorted by canonical form.
 */
export function findNearDuplicates(
  entries: Iterable<GlossaryEntryWithAliases>,
  opts: { fuzzy_distance?: number; fuzzy_prefix?: number } = {},
): GlossaryEntryWithAliases[][] {
  const fuzzyDistance = opts.fuzzy_distance ?? 2;
  const fuzzyPrefix = opts.fuzzy_prefix ?? 3;
  const materialised = [...entries];
  if (!materialised.length) return [];

  const buckets = new Map<string, GlossaryEntryWithAliases[]>();
  for (const entry of materialised) {
    const key = keySide(entry);
    if (!key) continue;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(entry);
  }

  const parent = new Map<string, string>();
  for (const k of buckets.keys()) parent.set(k, k);
  const find = (k: string): string => {
    let cur = k;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, parent.get(next)!);
      cur = parent.get(cur)!;
    }
    return cur;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  const keys = [...buckets.keys()].sort();
  if (fuzzyDistance > 0) {
    for (let i = 0; i < keys.length; i++) {
      const k1 = keys[i]!;
      for (let j = i + 1; j < keys.length; j++) {
        const k2 = keys[j]!;
        if (k1 === k2) continue;
        if (!k1 || !k2) continue;
        const prefix = Math.min(fuzzyPrefix, k1.length, k2.length);
        if (k1.slice(0, prefix) !== k2.slice(0, prefix)) continue;
        if (levenshtein(k1, k2, fuzzyDistance + 1) <= fuzzyDistance) {
          union(k1, k2);
        }
      }
    }
  }

  const grouped = new Map<string, GlossaryEntryWithAliases[]>();
  for (const [key, items] of buckets.entries()) {
    const root = find(key);
    let arr = grouped.get(root);
    if (!arr) {
      arr = [];
      grouped.set(root, arr);
    }
    arr.push(...items);
  }

  const statusRank: Record<string, number> = {
    locked: 0,
    confirmed: 1,
    proposed: 2,
  };
  const groups: GlossaryEntryWithAliases[][] = [];
  const roots = [...grouped.keys()].sort();
  for (const root of roots) {
    const members = grouped.get(root)!;
    if (members.length < 2) continue;
    members.sort((a, b) => {
      const sa = statusRank[a.entry.status] ?? 99;
      const sb = statusRank[b.entry.status] ?? 99;
      if (sa !== sb) return sa - sb;
      const ta = a.entry.type !== "term" ? 0 : 1;
      const tb = b.entry.type !== "term" ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
    });
    groups.push(members);
  }
  return groups;
}
