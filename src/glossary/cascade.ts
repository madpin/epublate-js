/**
 * Cascade re-translation flow (mirrors `epublate.glossary.cascade`).
 *
 * When a curator changes a confirmed/locked entry's `target_term` (or
 * promotes a proposed entry to locked), every previously translated
 * segment that touched the old terminology is potentially wrong. This
 * module exposes two recovery paths so the curator can pick the
 * trade-off that fits their edit:
 *
 * - `cascadeRetranslate` resets affected segments to `pending` so the
 *   next batch run re-translates them under the new term. Robust
 *   (the LLM gets a chance to re-phrase context that depends on the
 *   term) but slow + paid (one LLM call per segment).
 * - `applyTargetRename` does an in-place substring replacement of
 *   the old `target_term` with the new one. Free + instant, perfect
 *   for simple swaps ("feiticeiro" → "mago"), but blind to context —
 *   the surrounding sentence stays the way the LLM wrote it.
 *
 * Both paths share the same read-only preflight (`computeAffected`)
 * and emit history events so the audit log stays honest.
 */

import { openProjectDb } from "@/db/dexie";
import { nowMs } from "@/lib/time";
import { SegmentStatus } from "@/db/schema";
import { allSourceTerms, type GlossaryEntryWithAliases } from "./models";
import { makePattern } from "./matcher";

export interface CascadeCandidate {
  segment_id: string;
  chapter_id: string;
  idx: number;
  source_text: string;
  target_text: string | null;
  status: string;
  reason: string;
}

export async function computeAffected(opts: {
  project_id: string;
  entry: GlossaryEntryWithAliases;
  prev_target_term: string | null;
}): Promise<CascadeCandidate[]> {
  const { project_id, entry, prev_target_term } = opts;
  const srcPattern = makePattern(allSourceTerms(entry));
  const tgtPattern = prev_target_term ? makePattern([prev_target_term]) : null;
  if (srcPattern === null && tgtPattern === null) return [];

  const db = openProjectDb(project_id);
  const all = await db.segments.toArray();
  const out: CascadeCandidate[] = [];
  for (const seg of all) {
    if (seg.status === SegmentStatus.PENDING) continue;
    let srcHit = false;
    let tgtHit = false;
    if (srcPattern) {
      srcPattern.lastIndex = 0;
      srcHit = srcPattern.exec(seg.source_text) !== null;
    }
    if (tgtPattern && seg.target_text) {
      tgtPattern.lastIndex = 0;
      tgtHit = tgtPattern.exec(seg.target_text) !== null;
    }
    if (!srcHit && !tgtHit) continue;
    let reason: string;
    if (srcHit && tgtHit) reason = "source+target match";
    else if (srcHit) reason = "source match";
    else reason = "previous target match";
    out.push({
      segment_id: seg.id,
      chapter_id: seg.chapter_id,
      idx: seg.idx,
      source_text: seg.source_text,
      target_text: seg.target_text,
      status: seg.status,
      reason,
    });
  }
  return out;
}

export async function cascadeRetranslate(opts: {
  project_id: string;
  entry: GlossaryEntryWithAliases;
  prev_target_term: string | null;
  new_target_term: string | null;
  candidates: readonly CascadeCandidate[];
  reason?: string | null;
}): Promise<number> {
  const { project_id, entry, prev_target_term, new_target_term, candidates } = opts;
  if (!candidates.length) return 0;
  const db = openProjectDb(project_id);
  const ts = nowMs();
  await db.transaction("rw", db.segments, db.events, async () => {
    for (const cand of candidates) {
      await db.events.add({
        project_id,
        ts: nowMs(),
        kind: "segment.cascaded",
        payload_json: JSON.stringify({
          segment_id: cand.segment_id,
          entry_id: entry.entry.id,
          prev_target_term,
          new_target_term,
          prior_target_text: cand.target_text,
          prior_status: cand.status,
          reason: cand.reason,
        }),
      });
      await db.segments.update(cand.segment_id, {
        target_text: null,
        status: SegmentStatus.PENDING,
      });
    }
    await db.events.add({
      project_id,
      ts,
      kind: "glossary.cascaded",
      payload_json: JSON.stringify({
        entry_id: entry.entry.id,
        source_term: entry.entry.source_term,
        prev_target_term,
        new_target_term,
        affected_count: candidates.length,
        reason: opts.reason ?? null,
      }),
    });
  });
  return candidates.length;
}

export interface RenameSummary {
  /** Segments whose `target_text` was rewritten. */
  updated: number;
  /**
   * Segments where `prev_target_term` wasn't actually present in the
   * translation (source matched but target didn't, or the curator had
   * already manually swapped the term). These are left untouched.
   */
  skipped: number;
  /**
   * Total number of substring replacements performed. Useful when a
   * single segment carried the term multiple times.
   */
  replacements: number;
}

/**
 * In-place rename: rewrite every occurrence of `prev_target_term` to
 * `new_target_term` in the affected segments' `target_text`.
 *
 * Matching uses the same Unicode-aware boundary regex as the rest of
 * the glossary matcher (so "rei" doesn't accidentally consume
 * "reino"). Segments whose target doesn't actually contain the old
 * term are skipped — the curator can re-translate them via
 * `cascadeRetranslate` if needed.
 *
 * The status column is left untouched so a manually edited segment
 * stays approved, just with the term fixed.
 */
export async function applyTargetRename(opts: {
  project_id: string;
  entry: GlossaryEntryWithAliases;
  prev_target_term: string;
  new_target_term: string;
  candidates: readonly CascadeCandidate[];
  reason?: string | null;
}): Promise<RenameSummary> {
  const {
    project_id,
    entry,
    prev_target_term,
    new_target_term,
    candidates,
  } = opts;
  const summary: RenameSummary = { updated: 0, skipped: 0, replacements: 0 };
  if (!candidates.length) return summary;
  if (!prev_target_term) return summary;
  if (prev_target_term === new_target_term) {
    // No-op rename — the dialog shouldn't have offered the action,
    // but be defensive in case the caller has stale state.
    summary.skipped = candidates.length;
    return summary;
  }
  const pattern = makePattern([prev_target_term]);
  if (pattern === null) return summary;

  const db = openProjectDb(project_id);
  const ts = nowMs();
  await db.transaction("rw", db.segments, db.events, async () => {
    for (const cand of candidates) {
      if (!cand.target_text) {
        summary.skipped += 1;
        continue;
      }
      pattern.lastIndex = 0;
      // Count occurrences first so we report `replacements` accurately
      // — `String.replace(regex, ...)` doesn't expose the count.
      let count = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(cand.target_text)) !== null) {
        count += 1;
        if (m[0].length === 0) pattern.lastIndex += 1;
      }
      if (count === 0) {
        summary.skipped += 1;
        continue;
      }
      pattern.lastIndex = 0;
      const next_text = cand.target_text.replace(pattern, new_target_term);
      await db.segments.update(cand.segment_id, { target_text: next_text });
      await db.events.add({
        project_id,
        ts: nowMs(),
        kind: "segment.renamed",
        payload_json: JSON.stringify({
          segment_id: cand.segment_id,
          entry_id: entry.entry.id,
          prev_target_term,
          new_target_term,
          prior_target_text: cand.target_text,
          replacements: count,
          reason: cand.reason,
        }),
      });
      summary.updated += 1;
      summary.replacements += count;
    }
    await db.events.add({
      project_id,
      ts,
      kind: "glossary.renamed",
      payload_json: JSON.stringify({
        entry_id: entry.entry.id,
        source_term: entry.entry.source_term,
        prev_target_term,
        new_target_term,
        updated: summary.updated,
        skipped: summary.skipped,
        replacements: summary.replacements,
        reason: opts.reason ?? null,
      }),
    });
  });
  return summary;
}

