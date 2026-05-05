/**
 * Project-level cost / token / cache-hit aggregation
 * (mirrors `epublate.core.stats`).
 *
 * Reads `llm_calls` rows for the project and rolls them up into a
 * compact object the Dashboard / Inbox / Logs screens can render
 * directly. Because `llm_calls` is small relative to the segment
 * table — at most one row per attempted segment plus a handful of
 * helper-LLM rows — the simple "load all, fold in JS" approach is
 * fine for v1.
 */

import { openProjectDb } from "@/db/dexie";
import { SegmentStatus, type SegmentStatusT } from "@/db/schema";

export interface ProjectStats {
  /** All segments (translatable + trivially empty). */
  total_segments: number;
  pending: number;
  translated: number;
  validated: number;
  flagged: number;
  approved: number;
  /** Sum across every recorded LLM call. */
  prompt_tokens: number;
  completion_tokens: number;
  /** Cache hits cost zero. */
  cost_usd: number;
  cache_hits: number;
  cache_misses: number;
  llm_calls_total: number;
  /** Most recent event timestamp for the dashboard's "last activity" line. */
  last_activity_at: number | null;
}

export async function readProjectStats(
  project_id: string,
): Promise<ProjectStats> {
  const db = openProjectDb(project_id);

  const counts = await Promise.all([
    db.segments.count(),
    db.segments.where("status").equals(SegmentStatus.PENDING as SegmentStatusT).count(),
    db.segments.where("status").equals(SegmentStatus.TRANSLATED as SegmentStatusT).count(),
    db.segments.where("status").equals(SegmentStatus.VALIDATED as SegmentStatusT).count(),
    db.segments.where("status").equals(SegmentStatus.FLAGGED as SegmentStatusT).count(),
    db.segments.where("status").equals(SegmentStatus.APPROVED as SegmentStatusT).count(),
  ]);
  const [
    total_segments,
    pending,
    translated,
    validated,
    flagged,
    approved,
  ] = counts;

  let prompt_tokens = 0;
  let completion_tokens = 0;
  let cost_usd = 0;
  let cache_hits = 0;
  let cache_misses = 0;
  let llm_calls_total = 0;
  await db.llm_calls.each((row) => {
    llm_calls_total += 1;
    prompt_tokens += row.prompt_tokens ?? 0;
    completion_tokens += row.completion_tokens ?? 0;
    cost_usd += row.cost_usd ?? 0;
    if (row.cache_hit) cache_hits += 1;
    else cache_misses += 1;
  });

  let last_activity_at: number | null = null;
  const last_event = await db.events.orderBy("ts").last();
  if (last_event) last_activity_at = last_event.ts;

  return {
    total_segments,
    pending,
    translated,
    validated,
    flagged,
    approved,
    prompt_tokens,
    completion_tokens,
    cost_usd,
    cache_hits,
    cache_misses,
    llm_calls_total,
    last_activity_at,
  };
}

export interface InboxAlert {
  id: string;
  kind: "flagged_segment" | "proposed_entry" | "batch_failure" | "batch_paused";
  ts: number;
  /** Human-readable summary line. */
  message: string;
  /** Optional jump-target inside the project. */
  link: string | null;
}

/**
 * Compose an Inbox-friendly digest for the project.
 *
 * Mirrors the original tool's "flagged segments + proposed entries +
 * batch failures" layout (PRD §5.4) without persisting an extra table.
 * We just project from `events` + a couple of count queries.
 */
export async function readInboxDigest(project_id: string): Promise<{
  alerts: InboxAlert[];
  flagged_segments: number;
  proposed_entries: number;
}> {
  const db = openProjectDb(project_id);

  const flagged_segments = await db.segments
    .where("status")
    .equals(SegmentStatus.FLAGGED as SegmentStatusT)
    .count();

  // `proposed` glossary entries are the auto-proposer's queue.
  const proposed_entries = await db.glossary_entries
    .where("status")
    .equals("proposed")
    .count();

  const alerts: InboxAlert[] = [];

  // Pull the most recent N events of the kinds the inbox surfaces.
  const interesting = new Set([
    "segment.flagged",
    "entity.proposed",
    "batch.segment_failed",
    "batch.paused",
    "batch.cancelled",
  ]);
  const events = await db.events
    .orderBy("ts")
    .reverse()
    .limit(200)
    .toArray();
  for (const ev of events) {
    if (!interesting.has(ev.kind)) continue;
    const payload = safeParse(ev.payload_json);
    if (ev.kind === "segment.flagged") {
      const seg_id = String(payload?.segment_id ?? "");
      const violations = Array.isArray(payload?.violations) ? payload!.violations : [];
      alerts.push({
        id: `evt-${ev.id ?? `${ev.ts}-${seg_id}`}`,
        kind: "flagged_segment",
        ts: ev.ts,
        message: `Segment flagged · ${violations.length} violation${violations.length === 1 ? "" : "s"}`,
        link: `segment:${seg_id}`,
      });
    } else if (ev.kind === "entity.proposed") {
      alerts.push({
        id: `evt-${ev.id ?? ev.ts}`,
        kind: "proposed_entry",
        ts: ev.ts,
        message: `Auto-proposed: ${String(payload?.source_term ?? "(unknown)")}`,
        link: null,
      });
    } else if (ev.kind === "batch.segment_failed") {
      alerts.push({
        id: `evt-${ev.id ?? ev.ts}`,
        kind: "batch_failure",
        ts: ev.ts,
        message: `Batch failure · ${truncate(String(payload?.error ?? ""), 80)}`,
        link: `segment:${String(payload?.segment_id ?? "")}`,
      });
    } else if (ev.kind === "batch.paused" || ev.kind === "batch.cancelled") {
      alerts.push({
        id: `evt-${ev.id ?? ev.ts}`,
        kind: "batch_paused",
        ts: ev.ts,
        message:
          ev.kind === "batch.paused"
            ? `Batch paused · ${String(payload?.reason ?? "budget reached")}`
            : `Batch cancelled · ${String(payload?.reason ?? "by user")}`,
        link: null,
      });
    }
  }

  return { alerts, flagged_segments, proposed_entries };
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
