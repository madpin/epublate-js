/**
 * Glossary enforcer (mirrors `epublate.glossary.enforcer`).
 *
 * Three concerns live here:
 *
 * 1. **Build prompt constraints.** Convert glossary rows to
 *    `GlossaryConstraint`/`TargetOnlyConstraint` shapes the translator
 *    prompt understands. `proposed` entries are dropped — the LLM must
 *    not constrain against an un-vetted suggestion.
 *
 * 2. **Validate translations.** After the LLM call the pipeline must
 *    confirm that every locked entry whose source term appeared in the
 *    source segment is honored in the target. Confirmed entries warn
 *    only.
 *
 * 3. **Hash the glossary state.** The cache key
 *    `(model, system_hash, user_hash, glossary_hash)` needs
 *    `glossary_hash` to stay stable across runs and to flip whenever
 *    any LLM-visible glossary attribute changes.
 */

import { sha256Hex } from "@/lib/hash";
import type {
  GlossaryConstraint,
  TargetOnlyConstraint,
} from "@/llm/prompts/translator";
import { matchSource, targetUses } from "./matcher";
import {
  allTargetTerms,
  type GlossaryEntryWithAliases,
  type GlossaryStatusLiteral,
  type Match,
} from "./models";
import { findDoubledParticles } from "./normalize";

export type ViolationSeverity = "error" | "warning";
export type ViolationKind = "missing_locked_term" | "doubled_particle";

export interface Violation {
  entry_id: string;
  source_term: string;
  target_term: string;
  matched_source: string;
  severity: ViolationSeverity;
  message: string;
  kind: ViolationKind;
}

const PROMPT_STATUSES: readonly GlossaryStatusLiteral[] = ["locked", "confirmed"];

/**
 * Project entries to LLM-prompt-shape `GlossaryConstraint` rows.
 *
 * `proposed` entries are excluded entirely. The output is sorted
 * `locked` before `confirmed`, then alphabetically by source term, so
 * identical glossaries always produce identical prompts.
 *
 * Target-only entries (`source_known === false` / `source_term === null`)
 * are excluded too — they need a different prompt block built by
 * `buildTargetOnlyConstraints`.
 */
export function buildConstraints(
  entries: Iterable<GlossaryEntryWithAliases>,
): GlossaryConstraint[] {
  const byStatus: Record<GlossaryStatusLiteral, GlossaryEntryWithAliases[]> = {
    locked: [],
    confirmed: [],
    proposed: [],
  };
  for (const ent of entries) {
    if (!PROMPT_STATUSES.includes(ent.entry.status)) continue;
    if (ent.entry.source_term === null) continue;
    byStatus[ent.entry.status].push(ent);
  }
  const out: GlossaryConstraint[] = [];
  for (const status of PROMPT_STATUSES) {
    const bucket = [...byStatus[status]];
    bucket.sort((a, b) => {
      const sa = a.entry.source_term ?? "";
      const sb = b.entry.source_term ?? "";
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
    });
    for (const ent of bucket) {
      out.push({
        source_term: ent.entry.source_term ?? "",
        target_term: ent.entry.target_term,
        type: ent.entry.type,
        status,
        notes: ent.entry.notes,
        gender: ent.entry.gender,
      });
    }
  }
  return out;
}

/**
 * Project target-only entries to `TargetOnlyConstraint` rows.
 *
 * Filters in only entries whose `source_term` is null and `status` is
 * `locked` or `confirmed`. Output is sorted `locked` before
 * `confirmed`, then alphabetically by target term so identical
 * glossaries hash identically.
 */
export function buildTargetOnlyConstraints(
  entries: Iterable<GlossaryEntryWithAliases>,
): TargetOnlyConstraint[] {
  const byStatus: Record<GlossaryStatusLiteral, GlossaryEntryWithAliases[]> = {
    locked: [],
    confirmed: [],
    proposed: [],
  };
  for (const ent of entries) {
    if (!PROMPT_STATUSES.includes(ent.entry.status)) continue;
    if (ent.entry.source_term !== null) continue;
    byStatus[ent.entry.status].push(ent);
  }
  const out: TargetOnlyConstraint[] = [];
  for (const status of PROMPT_STATUSES) {
    const bucket = [...byStatus[status]];
    bucket.sort((a, b) => {
      if (a.entry.target_term !== b.entry.target_term) {
        return a.entry.target_term < b.entry.target_term ? -1 : 1;
      }
      return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
    });
    for (const ent of bucket) {
      const aliases = Array.from(new Set(ent.target_aliases)).sort();
      out.push({
        target_term: ent.entry.target_term,
        type: ent.entry.type,
        status,
        notes: ent.entry.notes,
        gender: ent.entry.gender,
        target_aliases: aliases,
      });
    }
  }
  return out;
}

/**
 * Return every locked/confirmed glossary violation in `target_text`.
 *
 * Algorithm:
 * 1. Run the source matcher to find which entries are relevant for
 *    this segment (only flag entries whose source actually appears).
 * 2. Check that the target term (or a target-side alias) appears in
 *    `target_text`.
 * 3. Locked → severity error; confirmed → severity warning.
 *    Target-only locked entries (PRD F-LB-9) downgrade to warning.
 */
export function validateTarget(opts: {
  source_text: string;
  target_text: string;
  entries: readonly GlossaryEntryWithAliases[];
}): Violation[] {
  const { source_text, target_text, entries } = opts;
  const relevant = entriesWithSourceMatch(source_text, entries);
  const violations: Violation[] = [];
  for (const { ent, hit } of relevant) {
    if (ent.entry.status === "proposed") continue;
    if (targetUses(target_text, ent)) continue;
    let severity: ViolationSeverity;
    if (ent.entry.status === "locked" && !ent.entry.source_known) {
      severity = "warning";
    } else {
      severity = ent.entry.status === "locked" ? "error" : "warning";
    }
    const sourceLabel = ent.entry.source_term ?? hit.term;
    violations.push({
      entry_id: ent.entry.id,
      source_term: sourceLabel,
      target_term: ent.entry.target_term,
      matched_source: hit.term,
      severity,
      kind: "missing_locked_term",
      message:
        `${severity}: ${ent.entry.status} entry '${sourceLabel}' → ` +
        `'${ent.entry.target_term}' missing from target ` +
        `(matched source as '${hit.term}')`,
    });
  }
  return violations;
}

export function hasLockedViolation(violations: Iterable<Violation>): boolean {
  for (const v of violations) {
    if (v.severity === "error") return true;
  }
  return false;
}

/**
 * True if any violation should flip the segment to `flagged`.
 *
 * Locked errors *plus* `doubled_particle` warnings flag the segment.
 * Confirmed-entry warnings still do not flag (they decorate only).
 */
export function hasFlaggingViolation(violations: Iterable<Violation>): boolean {
  let hasError = false;
  let hasDoubled = false;
  for (const v of violations) {
    if (v.severity === "error") hasError = true;
    if (v.kind === "doubled_particle") hasDoubled = true;
  }
  return hasError || hasDoubled;
}

/**
 * Soft-warn when the LLM's target repeats a function word.
 *
 * Examples to catch (Portuguese): `"Na na Europa"`, `"da da Câmara"`.
 * English: `"the the X"`, `"a a X"`. Each violation is severity
 * `"warning"` but `kind` `"doubled_particle"`, so
 * `hasFlaggingViolation` flips the segment to `flagged` even though
 * no locked term was missing.
 */
export function findTargetDoubledParticles(
  target_text: string,
  opts: { target_lang: string | null | undefined },
): Violation[] {
  const out: Violation[] = [];
  for (const [particle, offset] of findDoubledParticles(target_text, {
    lang: opts.target_lang,
  })) {
    out.push({
      entry_id: "",
      source_term: "",
      target_term: particle,
      matched_source: "",
      severity: "warning",
      kind: "doubled_particle",
      message:
        `target repeats the function word '${particle}' at char ${offset} ` +
        `(e.g. '${particle} ${particle}…') — likely a glossary ` +
        `particle-symmetry mismatch.`,
    });
  }
  return out;
}

/**
 * Deterministic hash of the LLM-visible glossary state.
 *
 * Used as the `glossary_hash` component of the cache key. Includes
 * only fields the model or the validator depends on. `id`,
 * `created_at` and `updated_at` are excluded so re-importing the
 * same glossary doesn't bust the cache.
 */
export async function glossaryHash(
  entries: Iterable<GlossaryEntryWithAliases>,
): Promise<string> {
  const sorted = [...entries].sort((a, b) => {
    const sa = a.entry.source_term ?? "";
    const sb = b.entry.source_term ?? "";
    if (sa !== sb) return sa < sb ? -1 : 1;
    if (a.entry.target_term !== b.entry.target_term) {
      return a.entry.target_term < b.entry.target_term ? -1 : 1;
    }
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
  });
  const canonical = sorted.map((ent) => ({
    type: ent.entry.type,
    source_term: ent.entry.source_term,
    target_term: ent.entry.target_term,
    status: ent.entry.status,
    gender: ent.entry.gender,
    notes: ent.entry.notes,
    source_known: ent.entry.source_known,
    source_aliases: [...ent.source_aliases].sort(),
    target_aliases: [...ent.target_aliases].sort(),
  }));
  const payload = stableStringify(canonical);
  const full = await sha256Hex(payload);
  return full.slice(0, 32);
}

/** Convenience wrapper around `matchSource` for the pipeline. */
export function findMentions(
  source_text: string,
  entries: readonly GlossaryEntryWithAliases[],
): Match[] {
  return matchSource(source_text, entries);
}

interface RelevantEntry {
  ent: GlossaryEntryWithAliases;
  hit: Match;
}

function entriesWithSourceMatch(
  source_text: string,
  entries: readonly GlossaryEntryWithAliases[],
): RelevantEntry[] {
  const byId = new Map<string, GlossaryEntryWithAliases>();
  for (const e of entries) byId.set(e.entry.id, e);
  const seen = new Set<string>();
  const out: RelevantEntry[] = [];
  for (const hit of matchSource(source_text, entries)) {
    if (seen.has(hit.entry_id)) continue;
    seen.add(hit.entry_id);
    const ent = byId.get(hit.entry_id);
    if (!ent) continue;
    out.push({ ent, hit });
  }
  return out;
}

/**
 * JSON.stringify with deterministic key ordering.
 *
 * Mirrors `json.dumps(payload, sort_keys=True, ensure_ascii=False)`.
 */
function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(", ") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}: ${stableStringify(obj[k])}`);
    return "{" + parts.join(", ") + "}";
  }
  return JSON.stringify(value);
}

// Convenience re-exports so callers don't have to import allTargetTerms.
export { allTargetTerms };
