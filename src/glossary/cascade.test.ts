/**
 * Tests for `cascade.ts`. The unit tests use Dexie via the same
 * project-DB factory the rest of the suite leans on, so we get real
 * IndexedDB transactions through fake-indexeddb (configured at the
 * vitest level).
 *
 * The cascade flow has two arms — re-translate (reset to pending)
 * and rename (in-place text replace). The shared `computeAffected`
 * preflight is exercised indirectly: every test seeds segments and
 * then calls one of the two action functions with hand-built
 * candidates.
 */

import { afterEach, describe, expect, it } from "vitest";

import { openProjectDb } from "@/db/dexie";
import { bulkInsertSegments } from "@/db/repo/segments";
import { createProject, deleteProject } from "@/db/repo/projects";
import { newId } from "@/lib/id";
import { sha256Hex } from "@/lib/hash";
import {
  applyTargetRename,
  cascadeRetranslate,
  computeAffected,
  type CascadeCandidate,
} from "@/glossary/cascade";
import type { GlossaryEntryWithAliases } from "@/glossary/models";
import { GlossaryStatus, SegmentStatus } from "@/db/schema";

const EMPTY_EPUB = new ArrayBuffer(0);

async function bootstrap(name: string): Promise<string> {
  const project = await createProject({
    name,
    source_lang: "en",
    target_lang: "pt",
    source_filename: `${name}.epub`,
    source_bytes: EMPTY_EPUB,
  });
  const db = openProjectDb(project.id);
  await db.chapters.add({
    id: "ch-1",
    project_id: project.id,
    spine_idx: 0,
    title: "Chapter 1",
    href: "ch1.xhtml",
    status: "pending" as const,
  });
  return project.id;
}

async function seedSegment(
  project_id: string,
  input: {
    id: string;
    idx: number;
    source: string;
    target: string | null;
    status?: import("@/db/schema").SegmentStatusT;
  },
): Promise<void> {
  await bulkInsertSegments(project_id, [
    {
      id: input.id,
      chapter_id: "ch-1",
      idx: input.idx,
      source_text: input.source,
      source_hash: await sha256Hex(input.source),
      inline_skeleton: [],
      host_path: "p[0]",
      host_part: 0,
      host_total_parts: 1,
      target_text: input.target,
      status: input.status ?? SegmentStatus.TRANSLATED,
    },
  ]);
}

function fakeEntry(input: {
  id?: string;
  source_term: string | null;
  target_term: string;
  status?: import("@/db/schema").GlossaryStatusT;
}): GlossaryEntryWithAliases {
  return {
    entry: {
      id: input.id ?? newId(),
      project_id: "p",
      type: "term",
      source_term: input.source_term,
      target_term: input.target_term,
      gender: null,
      status: input.status ?? GlossaryStatus.CONFIRMED,
      notes: null,
      first_seen_segment_id: null,
      created_at: 0,
      updated_at: 0,
      source_known: input.source_term !== null,
    },
    source_aliases: [],
    target_aliases: [],
  };
}

describe("computeAffected", () => {
  let projectId: string | null = null;
  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("returns segments matching either source or target", async () => {
    projectId = await bootstrap("affect-mix");
    await seedSegment(projectId, {
      id: "s1",
      idx: 0,
      source: "The wizard cast a spell.",
      target: "O feiticeiro lançou um feitiço.",
    });
    await seedSegment(projectId, {
      id: "s2",
      idx: 1,
      source: "She walked alone.",
      target: "Ela andava com o feiticeiro.",
    });
    await seedSegment(projectId, {
      id: "s3",
      idx: 2,
      source: "Rain fell.",
      target: "Chovia.",
    });
    const entry = fakeEntry({
      source_term: "wizard",
      target_term: "mago",
    });
    const out = await computeAffected({
      project_id: projectId,
      entry,
      prev_target_term: "feiticeiro",
    });
    const ids = out.map((c) => c.segment_id).sort();
    expect(ids).toEqual(["s1", "s2"]);
  });

  it("ignores pending segments (no translation to break)", async () => {
    projectId = await bootstrap("affect-pending");
    await seedSegment(projectId, {
      id: "s1",
      idx: 0,
      source: "The wizard cast a spell.",
      target: null,
      status: SegmentStatus.PENDING,
    });
    const entry = fakeEntry({
      source_term: "wizard",
      target_term: "mago",
    });
    const out = await computeAffected({
      project_id: projectId,
      entry,
      prev_target_term: "feiticeiro",
    });
    expect(out).toEqual([]);
  });
});

describe("applyTargetRename", () => {
  let projectId: string | null = null;
  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("rewrites the term in place across multiple segments", async () => {
    projectId = await bootstrap("rename-basic");
    await seedSegment(projectId, {
      id: "s1",
      idx: 0,
      source: "The wizard cast a spell.",
      target: "O feiticeiro lançou um feitiço.",
    });
    // s2 source matches but the target uses a pronoun — there's
    // nothing to rename, so applyTargetRename should `skip` it.
    await seedSegment(projectId, {
      id: "s2",
      idx: 1,
      source: "The wizard nodded.",
      target: "Ele assentiu.",
    });
    const entry = fakeEntry({
      source_term: "wizard",
      target_term: "mago",
    });
    const candidates = await computeAffected({
      project_id: projectId,
      entry,
      prev_target_term: "feiticeiro",
    });
    expect(candidates.map((c) => c.segment_id).sort()).toEqual(["s1", "s2"]);

    const summary = await applyTargetRename({
      project_id: projectId,
      entry,
      prev_target_term: "feiticeiro",
      new_target_term: "mago",
      candidates,
    });
    expect(summary.updated).toBe(1);
    expect(summary.skipped).toBe(1);

    const db = openProjectDb(projectId);
    const s1 = await db.segments.get("s1");
    const s2 = await db.segments.get("s2");
    expect(s1?.target_text).toBe("O mago lançou um feitiço.");
    expect(s2?.target_text).toBe("Ele assentiu.");
  });

  it("counts every occurrence of the old term as a replacement", async () => {
    projectId = await bootstrap("rename-multi");
    await seedSegment(projectId, {
      id: "s1",
      idx: 0,
      source: "The wizard met another wizard.",
      target: "O feiticeiro encontrou outro feiticeiro.",
    });
    const entry = fakeEntry({ source_term: "wizard", target_term: "mago" });
    const candidates = await computeAffected({
      project_id: projectId,
      entry,
      prev_target_term: "feiticeiro",
    });
    const summary = await applyTargetRename({
      project_id: projectId,
      entry,
      prev_target_term: "feiticeiro",
      new_target_term: "mago",
      candidates,
    });
    expect(summary.updated).toBe(1);
    expect(summary.replacements).toBe(2);
    const db = openProjectDb(projectId);
    expect((await db.segments.get("s1"))?.target_text).toBe(
      "O mago encontrou outro mago.",
    );
  });

  it("respects word boundaries — rei does not consume reino", async () => {
    projectId = await bootstrap("rename-word-boundary");
    await seedSegment(projectId, {
      id: "s1",
      idx: 0,
      source: "The king of the kingdom.",
      target: "O rei do reino.",
    });
    const entry = fakeEntry({ source_term: "king", target_term: "monarca" });
    const candidates = await computeAffected({
      project_id: projectId,
      entry,
      prev_target_term: "rei",
    });
    const summary = await applyTargetRename({
      project_id: projectId,
      entry,
      prev_target_term: "rei",
      new_target_term: "monarca",
      candidates,
    });
    expect(summary.updated).toBe(1);
    const db = openProjectDb(projectId);
    expect((await db.segments.get("s1"))?.target_text).toBe(
      "O monarca do reino.",
    );
  });

  it("preserves segment status — already-approved rows stay approved", async () => {
    projectId = await bootstrap("rename-status");
    await seedSegment(projectId, {
      id: "s1",
      idx: 0,
      source: "The wizard cast a spell.",
      target: "O feiticeiro lançou um feitiço.",
      status: SegmentStatus.APPROVED,
    });
    const entry = fakeEntry({ source_term: "wizard", target_term: "mago" });
    const candidates = await computeAffected({
      project_id: projectId,
      entry,
      prev_target_term: "feiticeiro",
    });
    await applyTargetRename({
      project_id: projectId,
      entry,
      prev_target_term: "feiticeiro",
      new_target_term: "mago",
      candidates,
    });
    const db = openProjectDb(projectId);
    expect((await db.segments.get("s1"))?.status).toBe(SegmentStatus.APPROVED);
  });

  it("emits segment.renamed + glossary.renamed events", async () => {
    projectId = await bootstrap("rename-events");
    await seedSegment(projectId, {
      id: "s1",
      idx: 0,
      source: "The wizard cast a spell.",
      target: "O feiticeiro lançou um feitiço.",
    });
    const entry = fakeEntry({ source_term: "wizard", target_term: "mago" });
    const candidates = await computeAffected({
      project_id: projectId,
      entry,
      prev_target_term: "feiticeiro",
    });
    await applyTargetRename({
      project_id: projectId,
      entry,
      prev_target_term: "feiticeiro",
      new_target_term: "mago",
      candidates,
    });
    const db = openProjectDb(projectId);
    const events = await db.events.toArray();
    const kinds = events.map((e) => e.kind).sort();
    expect(kinds).toContain("segment.renamed");
    expect(kinds).toContain("glossary.renamed");
  });

  it("is a no-op when prev_target equals new_target", async () => {
    projectId = await bootstrap("rename-noop");
    await seedSegment(projectId, {
      id: "s1",
      idx: 0,
      source: "The wizard cast a spell.",
      target: "O feiticeiro lançou um feitiço.",
    });
    const entry = fakeEntry({ source_term: "wizard", target_term: "feiticeiro" });
    const candidates = await computeAffected({
      project_id: projectId,
      entry,
      prev_target_term: "feiticeiro",
    });
    const summary = await applyTargetRename({
      project_id: projectId,
      entry,
      prev_target_term: "feiticeiro",
      new_target_term: "feiticeiro",
      candidates,
    });
    expect(summary.updated).toBe(0);
    expect(summary.replacements).toBe(0);
  });
});

describe("cascadeRetranslate (existing path)", () => {
  let projectId: string | null = null;
  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("nulls target_text and resets status to pending", async () => {
    projectId = await bootstrap("cascade-reset");
    await seedSegment(projectId, {
      id: "s1",
      idx: 0,
      source: "The wizard cast a spell.",
      target: "O feiticeiro lançou um feitiço.",
      status: SegmentStatus.APPROVED,
    });
    const entry = fakeEntry({ source_term: "wizard", target_term: "mago" });
    const db = openProjectDb(projectId);
    const candidates: CascadeCandidate[] = [
      {
        segment_id: "s1",
        chapter_id: "ch-1",
        idx: 0,
        source_text: "The wizard cast a spell.",
        target_text: "O feiticeiro lançou um feitiço.",
        status: SegmentStatus.APPROVED,
        reason: "manual",
      },
    ];
    const n = await cascadeRetranslate({
      project_id: projectId,
      entry,
      prev_target_term: "feiticeiro",
      new_target_term: "mago",
      candidates,
    });
    expect(n).toBe(1);
    const after = await db.segments.get("s1");
    expect(after?.target_text).toBeNull();
    expect(after?.status).toBe(SegmentStatus.PENDING);
  });
});
