/**
 * Segment-row CRUD (mirrors `epublate.db.repo.segment`).
 *
 * The Python repo packs the inline-skeleton list **plus** the host
 * XPath / part metadata into a single JSON envelope stored in the
 * SQLite ``segment.inline_skeleton`` BLOB column. We keep that exact
 * wire shape so the JSONL export is a byte-for-byte round-trip with
 * the Python tool. The envelope:
 *
 * ```json
 * { "skeleton": [...], "host_path": "/p[1]", "host_part": 0, "host_total_parts": 1 }
 * ```
 */

import { openProjectDb } from "../dexie";
import {
  type SegmentRow,
  type SegmentStatusT,
  SegmentStatus,
} from "../schema";
import type { InlineToken, Segment } from "@/formats/epub/types";

export interface SegmentInsert {
  id: string;
  chapter_id: string;
  idx: number;
  source_text: string;
  source_hash: string;
  inline_skeleton: InlineToken[];
  host_path: string;
  host_part: number;
  host_total_parts: number;
  target_text?: string | null;
  status?: SegmentStatusT;
}

interface SkeletonEnvelope {
  skeleton: InlineToken[];
  host_path: string;
  host_part: number;
  host_total_parts: number;
}

export function encodeSkeletonEnvelope(seg: SegmentInsert | Segment): string {
  const env: SkeletonEnvelope = {
    skeleton: seg.inline_skeleton,
    host_path: seg.host_path,
    host_part: seg.host_part,
    host_total_parts: seg.host_total_parts,
  };
  return JSON.stringify(env);
}

export function decodeSkeletonEnvelope(blob: string | null): SkeletonEnvelope {
  if (!blob) {
    return { skeleton: [], host_path: "", host_part: 0, host_total_parts: 1 };
  }
  const parsed = JSON.parse(blob) as
    | InlineToken[]
    | Partial<SkeletonEnvelope>;
  if (Array.isArray(parsed)) {
    // Tolerate a bare-skeleton legacy shape, mirroring the Python
    // import-path. Production data always has an envelope.
    return {
      skeleton: parsed,
      host_path: "",
      host_part: 0,
      host_total_parts: 1,
    };
  }
  return {
    skeleton: parsed.skeleton ?? [],
    host_path: parsed.host_path ?? "",
    host_part: parsed.host_part ?? 0,
    host_total_parts: parsed.host_total_parts ?? 1,
  };
}

export async function bulkInsertSegments(
  projectId: string,
  segments: SegmentInsert[],
): Promise<void> {
  if (segments.length === 0) return;
  const rows: SegmentRow[] = segments.map((seg) => ({
    id: seg.id,
    chapter_id: seg.chapter_id,
    idx: seg.idx,
    source_text: seg.source_text,
    source_hash: seg.source_hash,
    target_text: seg.target_text ?? null,
    status: seg.status ?? SegmentStatus.PENDING,
    inline_skeleton: encodeSkeletonEnvelope(seg),
  }));
  const db = openProjectDb(projectId);
  await db.segments.bulkPut(rows);
}

export async function listSegmentsForChapter(
  projectId: string,
  chapterId: string,
): Promise<Segment[]> {
  const db = openProjectDb(projectId);
  const rows = await db.segments
    .where("[chapter_id+idx]")
    .between([chapterId, 0], [chapterId, Infinity])
    .toArray();
  return rows.map(rowToSegment);
}

export async function getSegment(
  projectId: string,
  segmentId: string,
): Promise<Segment | undefined> {
  const db = openProjectDb(projectId);
  const row = await db.segments.get(segmentId);
  return row ? rowToSegment(row) : undefined;
}

export async function updateSegmentTarget(
  projectId: string,
  segmentId: string,
  patch: { target_text: string | null; status: SegmentStatusT },
): Promise<void> {
  const db = openProjectDb(projectId);
  await db.segments.update(segmentId, patch);
}

export async function countSegments(
  projectId: string,
  chapterId?: string,
): Promise<number> {
  const db = openProjectDb(projectId);
  if (!chapterId) return db.segments.count();
  return db.segments.where("chapter_id").equals(chapterId).count();
}

/**
 * Returns a `chapter_id → pending segment count` map for the project.
 *
 * Uses the `status` index, so the scan touches only PENDING rows; we
 * group in memory to avoid issuing one count per chapter (which scales
 * poorly with chaptered books).
 */
export async function countPendingByChapter(
  projectId: string,
): Promise<Map<string, number>> {
  const db = openProjectDb(projectId);
  const out = new Map<string, number>();
  await db.segments
    .where("status")
    .equals(SegmentStatus.PENDING)
    .each((row) => {
      out.set(row.chapter_id, (out.get(row.chapter_id) ?? 0) + 1);
    });
  return out;
}

/**
 * Group a set of in-flight segment IDs by chapter so the Reader can
 * paint a per-chapter "running" badge. Reads only the segment IDs in
 * `segment_ids`; if the set is empty we short-circuit without a DB
 * round-trip.
 *
 * The returned map carries a count rather than a boolean so the UI can
 * distinguish "1 in flight" from "23 in flight" when a batch is mid-
 * sweep on a long chapter.
 */
export async function countRunningByChapter(
  projectId: string,
  segment_ids: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (segment_ids.size === 0) return out;
  const db = openProjectDb(projectId);
  await db.segments
    .where("id")
    .anyOf([...segment_ids])
    .each((row) => {
      out.set(row.chapter_id, (out.get(row.chapter_id) ?? 0) + 1);
    });
  return out;
}

export function rowToSegment(row: SegmentRow): Segment {
  const env = decodeSkeletonEnvelope(row.inline_skeleton);
  return {
    id: row.id,
    chapter_id: row.chapter_id,
    idx: row.idx,
    source_text: row.source_text,
    source_hash: row.source_hash,
    target_text: row.target_text,
    inline_skeleton: env.skeleton,
    host_path: env.host_path,
    host_part: env.host_part,
    host_total_parts: env.host_total_parts,
  };
}
