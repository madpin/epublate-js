/**
 * Cascade re-translation flow (mirrors `epublate.glossary.cascade`).
 *
 * When a curator changes a confirmed/locked entry's `target_term` (or
 * promotes a proposed entry to locked), every previously translated
 * segment that touched the old terminology is potentially wrong. This
 * module computes the affected set and rolls them back to `pending`.
 *
 * The flow is two-phase:
 * 1. `computeAffected` — read-only, side-effect free.
 * 2. `cascadeRetranslate` — runs in a single transaction; emits
 *    `segment.cascaded` events with the prior translation so history
 *    is preserved even though the target column is then nulled.
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

