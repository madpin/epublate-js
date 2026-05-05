import { afterEach, describe, expect, it } from "vitest";

import { createProject, deleteProject } from "@/db/repo/projects";
import {
  bulkUpsertEmbeddings,
  cosineTopK,
  countEmbeddingsByScope,
  deleteEmbeddingsForRef,
  getEmbedding,
  listEmbeddingsByScope,
  upsertEmbedding,
} from "@/db/repo/embeddings";
import { unpackFloat32 } from "@/llm/embeddings/base";

async function makeProject(): Promise<string> {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const p = await createProject({
    name: "Embed Test",
    source_lang: "en",
    target_lang: "pt",
    source_filename: "e.epub",
    source_bytes: bytes.buffer,
  });
  return p.id;
}

function vec(values: number[]): Float32Array {
  return Float32Array.from(values);
}

describe("embeddings repo", () => {
  let projectId: string | null = null;

  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("upsert is idempotent on (scope, ref_id, model)", async () => {
    projectId = await makeProject();
    const v1 = vec([0.1, 0.2, 0.3]);
    const a = await upsertEmbedding("project", projectId, {
      scope: "segment",
      ref_id: "seg-1",
      model: "m",
      vector: v1,
    });
    const v2 = vec([0.4, 0.5, 0.6]);
    const b = await upsertEmbedding("project", projectId, {
      scope: "segment",
      ref_id: "seg-1",
      model: "m",
      vector: v2,
    });
    expect(b.id).toBe(a.id);
    const got = await getEmbedding(
      "project",
      projectId,
      "segment",
      "seg-1",
      "m",
    );
    expect(got).toBeDefined();
    expect(Array.from(unpackFloat32(got!.vector))).toEqual([
      Math.fround(0.4),
      Math.fround(0.5),
      Math.fround(0.6),
    ]);
  });

  it("treats different models as separate rows for the same ref_id", async () => {
    projectId = await makeProject();
    await upsertEmbedding("project", projectId, {
      scope: "segment",
      ref_id: "seg-1",
      model: "model-a",
      vector: vec([1, 0, 0]),
    });
    await upsertEmbedding("project", projectId, {
      scope: "segment",
      ref_id: "seg-1",
      model: "model-b",
      vector: vec([0, 1, 0]),
    });
    const a = await getEmbedding(
      "project",
      projectId,
      "segment",
      "seg-1",
      "model-a",
    );
    const b = await getEmbedding(
      "project",
      projectId,
      "segment",
      "seg-1",
      "model-b",
    );
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.id).not.toBe(b!.id);
  });

  it("scopes are independent — segment vs glossary_entry don't collide", async () => {
    projectId = await makeProject();
    await upsertEmbedding("project", projectId, {
      scope: "segment",
      ref_id: "shared-id",
      model: "m",
      vector: vec([1, 0, 0]),
    });
    await upsertEmbedding("project", projectId, {
      scope: "glossary_entry",
      ref_id: "shared-id",
      model: "m",
      vector: vec([0, 1, 0]),
    });
    expect(
      await countEmbeddingsByScope("project", projectId, "segment", "m"),
    ).toBe(1);
    expect(
      await countEmbeddingsByScope(
        "project",
        projectId,
        "glossary_entry",
        "m",
      ),
    ).toBe(1);
  });

  it("listEmbeddingsByScope returns only matching scope+model", async () => {
    projectId = await makeProject();
    await bulkUpsertEmbeddings("project", projectId, [
      {
        scope: "segment",
        ref_id: "seg-1",
        model: "m",
        vector: vec([1, 0]),
      },
      {
        scope: "segment",
        ref_id: "seg-2",
        model: "m",
        vector: vec([0, 1]),
      },
      {
        scope: "segment",
        ref_id: "seg-3",
        model: "other",
        vector: vec([0.5, 0.5]),
      },
      {
        scope: "glossary_entry",
        ref_id: "ent-1",
        model: "m",
        vector: vec([0.3, 0.3]),
      },
    ]);
    const rows = await listEmbeddingsByScope(
      "project",
      projectId,
      "segment",
      "m",
    );
    expect(rows.map((r) => r.ref_id).sort()).toEqual(["seg-1", "seg-2"]);
  });

  it("deleteEmbeddingsForRef removes every model's row for the ref", async () => {
    projectId = await makeProject();
    await bulkUpsertEmbeddings("project", projectId, [
      {
        scope: "segment",
        ref_id: "seg-1",
        model: "m1",
        vector: vec([1, 0]),
      },
      {
        scope: "segment",
        ref_id: "seg-1",
        model: "m2",
        vector: vec([0, 1]),
      },
      {
        scope: "segment",
        ref_id: "seg-2",
        model: "m1",
        vector: vec([0.5, 0.5]),
      },
    ]);
    await deleteEmbeddingsForRef("project", projectId, "segment", "seg-1");
    expect(
      await getEmbedding("project", projectId, "segment", "seg-1", "m1"),
    ).toBeUndefined();
    expect(
      await getEmbedding("project", projectId, "segment", "seg-1", "m2"),
    ).toBeUndefined();
    expect(
      await getEmbedding("project", projectId, "segment", "seg-2", "m1"),
    ).toBeDefined();
  });
});

describe("cosineTopK", () => {
  let projectId: string | null = null;

  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("ranks rows by cosine similarity descending", async () => {
    projectId = await makeProject();
    // Build a tiny corpus where each segment has a known angle from
    // the query (1, 0). Order from most→least similar:
    // seg-self (1, 0)            cos = 1.0
    // seg-near (0.9, 0.43)       cos ≈ 0.9
    // seg-mid  (0.5, 0.87)       cos ≈ 0.5
    // seg-far  (0, 1)            cos = 0
    await bulkUpsertEmbeddings("project", projectId, [
      {
        scope: "segment",
        ref_id: "seg-self",
        model: "m",
        vector: vec([1, 0]),
      },
      {
        scope: "segment",
        ref_id: "seg-near",
        model: "m",
        vector: vec([0.9, 0.43]),
      },
      {
        scope: "segment",
        ref_id: "seg-mid",
        model: "m",
        vector: vec([0.5, 0.87]),
      },
      {
        scope: "segment",
        ref_id: "seg-far",
        model: "m",
        vector: vec([0, 1]),
      },
    ]);
    const hits = await cosineTopK(
      "project",
      projectId,
      "segment",
      "m",
      vec([1, 0]),
      { k: 3 },
    );
    expect(hits.map((h) => h.ref_id)).toEqual([
      "seg-self",
      "seg-near",
      "seg-mid",
    ]);
    expect(hits[0]!.similarity).toBeGreaterThan(0.999);
    expect(hits[1]!.similarity).toBeGreaterThan(0.85);
    expect(hits[2]!.similarity).toBeLessThan(0.6);
  });

  it("min_similarity filters out weak matches", async () => {
    projectId = await makeProject();
    await bulkUpsertEmbeddings("project", projectId, [
      {
        scope: "segment",
        ref_id: "seg-strong",
        model: "m",
        vector: vec([1, 0]),
      },
      {
        scope: "segment",
        ref_id: "seg-weak",
        model: "m",
        vector: vec([0.05, 1]),
      },
    ]);
    const hits = await cosineTopK(
      "project",
      projectId,
      "segment",
      "m",
      vec([1, 0]),
      { k: 5, min_similarity: 0.5 },
    );
    expect(hits.map((h) => h.ref_id)).toEqual(["seg-strong"]);
  });

  it("filter set restricts the search space", async () => {
    projectId = await makeProject();
    await bulkUpsertEmbeddings("project", projectId, [
      {
        scope: "segment",
        ref_id: "seg-1",
        model: "m",
        vector: vec([1, 0]),
      },
      {
        scope: "segment",
        ref_id: "seg-2",
        model: "m",
        vector: vec([0.99, 0.14]),
      },
      {
        scope: "segment",
        ref_id: "seg-3",
        model: "m",
        vector: vec([0.95, 0.31]),
      },
    ]);
    const hits = await cosineTopK(
      "project",
      projectId,
      "segment",
      "m",
      vec([1, 0]),
      { k: 5, filter: new Set(["seg-2", "seg-3"]) },
    );
    expect(hits.map((h) => h.ref_id)).toEqual(["seg-2", "seg-3"]);
  });

  it("exclude_ref_id drops the self-match", async () => {
    projectId = await makeProject();
    await bulkUpsertEmbeddings("project", projectId, [
      {
        scope: "segment",
        ref_id: "self",
        model: "m",
        vector: vec([1, 0]),
      },
      {
        scope: "segment",
        ref_id: "other",
        model: "m",
        vector: vec([0.9, 0.43]),
      },
    ]);
    const hits = await cosineTopK(
      "project",
      projectId,
      "segment",
      "m",
      vec([1, 0]),
      { k: 5, exclude_ref_id: "self" },
    );
    expect(hits.map((h) => h.ref_id)).toEqual(["other"]);
  });

  it("returns an empty list when k is 0", async () => {
    projectId = await makeProject();
    await upsertEmbedding("project", projectId, {
      scope: "segment",
      ref_id: "seg-1",
      model: "m",
      vector: vec([1, 0]),
    });
    const hits = await cosineTopK(
      "project",
      projectId,
      "segment",
      "m",
      vec([1, 0]),
      { k: 0 },
    );
    expect(hits).toEqual([]);
  });

  it("returns an empty list when no rows match the (scope, model) pair", async () => {
    projectId = await makeProject();
    const hits = await cosineTopK(
      "project",
      projectId,
      "segment",
      "missing-model",
      vec([1, 0]),
      { k: 5 },
    );
    expect(hits).toEqual([]);
  });

  it("ties break deterministically on ref_id ascending", async () => {
    projectId = await makeProject();
    await bulkUpsertEmbeddings("project", projectId, [
      {
        scope: "segment",
        ref_id: "z-tie",
        model: "m",
        vector: vec([1, 0]),
      },
      {
        scope: "segment",
        ref_id: "a-tie",
        model: "m",
        vector: vec([1, 0]),
      },
    ]);
    const hits = await cosineTopK(
      "project",
      projectId,
      "segment",
      "m",
      vec([1, 0]),
      { k: 2 },
    );
    expect(hits.map((h) => h.ref_id)).toEqual(["a-tie", "z-tie"]);
  });
});
