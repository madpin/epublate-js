/**
 * Tests for the {@link EmbeddingPrefetcher} — the producer-consumer
 * shim that lets translator workers piggyback on bulk `embed()` calls
 * instead of paying for one round-trip per segment.
 *
 * The contract we lock down here:
 *
 *  1. **Bulk batching.** A book of N segments resolves with at most
 *     `ceil(N / batch_size)` calls to `provider.embed`, regardless of
 *     how many translator workers race ahead of the prefetcher.
 *  2. **Promise sharing.** Workers asking for a segment that's part
 *     of an in-flight batch get the same promise; we never fire two
 *     embeds for the same segment id.
 *  3. **IDB cache hit path.** Already-embedded segments short-circuit
 *     to `unpackFloat32` of the persisted row — no provider call.
 *  4. **Audit + duration.** Each batch writes one `llm_calls` row
 *     whose `duration_ms` is the wall-clock duration reported by the
 *     provider, and `response_json` carries the full raw payload
 *     (vectors count + dim + raw + usage) — the curator can grep the
 *     audit for any field the provider returned.
 *  5. **Failure isolation.** A provider error doesn't sink the
 *     prefetcher: waiters resolve with `null` so the pipeline can
 *     fall back to the legacy flat-merge path, and an
 *     `embedding.failed` event lands on the project event log.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { EmbeddingPrefetcher } from "@/core/embedding_prefetch";
import { openProjectDb } from "@/db/dexie";
import { recentLlmCalls } from "@/db/repo/llm_calls";
import { createProject, deleteProject } from "@/db/repo/projects";
import {
  ChapterStatus,
  type SegmentRow,
  SegmentStatus,
} from "@/db/schema";
import {
  type EmbeddingProvider,
  type EmbeddingResult,
} from "@/llm/embeddings/base";
import { type Segment } from "@/formats/epub/types";
import {
  MockEmbeddingProvider,
  pseudoVector,
} from "@/llm/embeddings/mock";

async function makeProject(): Promise<string> {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const p = await createProject({
    name: "Prefetch Test",
    source_lang: "en",
    target_lang: "pt",
    source_filename: "p.epub",
    source_bytes: bytes.buffer,
  });
  return p.id;
}

async function seedSegments(
  project_id: string,
  count: number,
): Promise<SegmentRow[]> {
  const db = openProjectDb(project_id);
  const chapter_id = `ch-${project_id}-1`;
  await db.chapters.put({
    id: chapter_id,
    project_id,
    spine_idx: 0,
    href: "ch1.xhtml",
    title: "ch1",
    status: ChapterStatus.PENDING,
    notes: null,
  });
  const rows: SegmentRow[] = Array.from({ length: count }, (_, i) => ({
    id: `seg-${project_id}-${i}`,
    chapter_id,
    idx: i,
    source_text: `lorem ipsum ${i} dolor sit amet`,
    source_hash: `h${i}`,
    target_text: null,
    status: SegmentStatus.PENDING,
    inline_skeleton: JSON.stringify({
      skeleton: [],
      host_path: "p[0]",
      host_part: 0,
      host_total_parts: 1,
    }),
  }));
  await db.segments.bulkPut(rows);
  return rows;
}

function asSegment(row: SegmentRow): Segment {
  return {
    id: row.id,
    chapter_id: row.chapter_id,
    idx: row.idx,
    source_text: row.source_text,
    source_hash: row.source_hash,
    target_text: row.target_text,
    inline_skeleton: [],
    host_path: "p[0]",
    host_part: 0,
    host_total_parts: 1,
  };
}

describe("EmbeddingPrefetcher", () => {
  let projectId: string | null = null;

  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("collapses N singleton embeds into ceil(N/batch_size) bulk calls", async () => {
    projectId = await makeProject();
    const segs = await seedSegments(projectId, 50);

    const provider = new MockEmbeddingProvider({ dim: 16, batch_size: 16 });
    const spy = vi.spyOn(provider, "embed");
    const prefetcher = new EmbeddingPrefetcher(projectId, provider);

    // Workers race the prefetcher: half of them ask for embeddings
    // *before* warmCache finishes — they should pick up the in-flight
    // batch promise, not fire their own embeds.
    const warm = prefetcher.warmCache(segs, { parallel_batches: 2 });
    const racing = segs.slice(0, 25).map((s) =>
      prefetcher.getEmbedding(asSegment(s)),
    );
    await Promise.all([warm, Promise.all(racing)]);

    // 50 segments at batch_size=16 → ceil(50/16) = 4 batches.
    expect(spy).toHaveBeenCalledTimes(4);
    spy.mockRestore();
  });

  it("returns the same Float32Array values as a direct provider.embed", async () => {
    projectId = await makeProject();
    const segs = await seedSegments(projectId, 4);
    const provider = new MockEmbeddingProvider({ dim: 32, batch_size: 4 });
    const prefetcher = new EmbeddingPrefetcher(projectId, provider);
    await prefetcher.warmCache(segs);

    const direct = await pseudoVector(segs[0]!.source_text, 32);
    const prefetched = await prefetcher.getEmbedding(asSegment(segs[0]!));
    expect(prefetched).not.toBeNull();
    expect(Array.from(prefetched!)).toEqual(Array.from(direct));
  });

  it("audits each batch with duration_ms and the full raw response", async () => {
    projectId = await makeProject();
    const segs = await seedSegments(projectId, 8);
    const provider = new MockEmbeddingProvider({ dim: 16, batch_size: 4 });
    const prefetcher = new EmbeddingPrefetcher(projectId, provider);
    await prefetcher.warmCache(segs);

    const calls = await recentLlmCalls(projectId, 100);
    const embeds = calls.filter((c) => c.purpose === "embedding");
    expect(embeds.length).toBe(2); // 8 segs / batch_size 4 = 2 batches.
    for (const row of embeds) {
      // Mock provider always reports a non-negative finite duration.
      expect(typeof row.duration_ms).toBe("number");
      expect(row.duration_ms).toBeGreaterThanOrEqual(0);
      // Response JSON carries the full payload — vectors / dim / raw —
      // so the LLM Activity screen never truncates an embedding row.
      const parsed = JSON.parse(row.response_json ?? "null") as {
        vectors: number;
        dim: number;
        model: string;
        usage: { prompt_tokens: number };
        duration_ms: number;
        raw: { mock: boolean; count: number };
      };
      expect(parsed.vectors).toBe(4);
      expect(parsed.dim).toBe(16);
      expect(parsed.model).toBe(provider.model);
      expect(parsed.raw.mock).toBe(true);
      expect(parsed.raw.count).toBe(4);
      expect(parsed.usage.prompt_tokens).toBeGreaterThan(0);
    }
  });

  it("hits the IDB cache on the second pass (no provider call)", async () => {
    projectId = await makeProject();
    const segs = await seedSegments(projectId, 6);
    const provider = new MockEmbeddingProvider({ dim: 16, batch_size: 4 });
    const prefetcher = new EmbeddingPrefetcher(projectId, provider);
    await prefetcher.warmCache(segs);

    const spy = vi.spyOn(provider, "embed");
    const prefetcher_two = new EmbeddingPrefetcher(projectId, provider);
    await prefetcher_two.warmCache(segs);
    expect(spy).not.toHaveBeenCalled();

    // And singleton lookups against the second prefetcher still
    // resolve, sourced from the IDB cache.
    const v = await prefetcher_two.getEmbedding(asSegment(segs[2]!));
    expect(v).not.toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("resolves waiters with null and emits embedding.failed on provider failure", async () => {
    projectId = await makeProject();
    const segs = await seedSegments(projectId, 3);

    // Hand-rolled provider that always throws — we don't want to lean
    // on the mock's deterministic vectors here.
    const failing: EmbeddingProvider = {
      name: "fail",
      model: "fail-embed",
      dim: 16,
      batch_size: 16,
      async embed(): Promise<EmbeddingResult> {
        throw new Error("provider down");
      },
    };
    const prefetcher = new EmbeddingPrefetcher(projectId, failing);
    await prefetcher.warmCache(segs);

    const v = await prefetcher.getEmbedding(asSegment(segs[0]!));
    expect(v).toBeNull();

    const db = openProjectDb(projectId);
    const events = await db.events
      .where("kind")
      .equals("embedding.failed")
      .toArray();
    expect(events.length).toBeGreaterThan(0);
  });
});
