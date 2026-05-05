/**
 * Glossary value objects (mirrors `epublate.glossary.models`).
 *
 * The matcher, enforcer, cascade, and Glossary screen all work with
 * the *composite* `GlossaryEntryWithAliases` view (entry + its
 * aliases) so they don't have to do three joins themselves. The
 * persistence-layer rows (`GlossaryEntryRow`, `GlossaryAliasRow`,
 * `GlossaryRevisionRow`) live in `db/schema.ts`; this module is the
 * cross-module contract.
 */

import type {
  AliasSide,
  EntityType,
  GenderTag,
  GlossaryEntryRow,
  GlossaryStatusT,
} from "@/db/schema";

export type { AliasSide, EntityType, GenderTag };
export type GlossaryStatusLiteral = GlossaryStatusT;

/** One canonical lore-bible row + its alias bag. */
export interface GlossaryEntryWithAliases {
  entry: GlossaryEntryRow;
  source_aliases: string[];
  target_aliases: string[];
}

/** Convenience accessors mirroring the Python composite's `@property`s. */
export const entry_id = (e: GlossaryEntryWithAliases): string => e.entry.id;
export const entry_status = (e: GlossaryEntryWithAliases): GlossaryStatusLiteral =>
  e.entry.status;
export const entry_source_term = (e: GlossaryEntryWithAliases): string | null =>
  e.entry.source_term;
export const entry_target_term = (e: GlossaryEntryWithAliases): string =>
  e.entry.target_term;
export const entry_source_known = (e: GlossaryEntryWithAliases): boolean =>
  e.entry.source_known;

/** Canonical source term + source aliases (deduped, ordered). */
export function allSourceTerms(e: GlossaryEntryWithAliases): string[] {
  const seen = new Map<string, true>();
  if (e.entry.source_term) seen.set(e.entry.source_term, true);
  for (const alias of e.source_aliases) {
    if (alias && !seen.has(alias)) seen.set(alias, true);
  }
  return [...seen.keys()];
}

/** Canonical target term + target aliases (deduped, ordered). */
export function allTargetTerms(e: GlossaryEntryWithAliases): string[] {
  const seen = new Map<string, true>();
  seen.set(e.entry.target_term, true);
  for (const alias of e.target_aliases) {
    if (alias && !seen.has(alias)) seen.set(alias, true);
  }
  return [...seen.keys()];
}

export interface Match {
  entry_id: string;
  term: string;
  start: number;
  end: number;
}
