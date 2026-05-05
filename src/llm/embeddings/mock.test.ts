import { describe, expect, it } from "vitest";

import {
  cosine,
  packFloat32,
  unpackFloat32,
} from "@/llm/embeddings/base";
import {
  MockEmbeddingProvider,
  pseudoVector,
} from "@/llm/embeddings/mock";

describe("MockEmbeddingProvider", () => {
  it("produces vectors of the configured dim", async () => {
    const provider = new MockEmbeddingProvider({ dim: 64 });
    const result = await provider.embed(["alpha", "beta", "gamma"]);
    expect(result.vectors).toHaveLength(3);
    for (const v of result.vectors) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(64);
    }
    expect(result.model).toBe("mock-embed");
    expect(result.usage?.prompt_tokens).toBeGreaterThan(0);
  });

  it("is deterministic across runs (same input ⇒ same vector)", async () => {
    const a = new MockEmbeddingProvider({ dim: 32 });
    const b = new MockEmbeddingProvider({ dim: 32 });
    const result_a = await a.embed(["the same text"]);
    const result_b = await b.embed(["the same text"]);
    expect(Array.from(result_a.vectors[0]!)).toEqual(
      Array.from(result_b.vectors[0]!),
    );
  });

  it("produces distinct vectors for distinct strings", async () => {
    const provider = new MockEmbeddingProvider({ dim: 32 });
    const result = await provider.embed(["alpha", "beta"]);
    const sim = cosine(result.vectors[0]!, result.vectors[1]!);
    // Pseudo-random vectors should be far from collinear; orthogonal-
    // ish is the expectation for unrelated strings.
    expect(Math.abs(sim)).toBeLessThan(0.95);
  });

  it("self-cosine equals 1 (vectors are L2-normalized)", async () => {
    const provider = new MockEmbeddingProvider({ dim: 64 });
    const result = await provider.embed(["the quick brown fox"]);
    const v = result.vectors[0]!;
    const sim = cosine(v, v);
    expect(sim).toBeGreaterThan(0.999999);
    expect(sim).toBeLessThanOrEqual(1.0000001);
  });

  it("pseudoVector is reproducible standalone", async () => {
    const a = await pseudoVector("hello world", 16);
    const b = await pseudoVector("hello world", 16);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("rejects non-positive dim at construction", () => {
    expect(() => new MockEmbeddingProvider({ dim: 0 })).toThrow();
    expect(() => new MockEmbeddingProvider({ dim: -1 })).toThrow();
  });

  it("supports an empty input list", async () => {
    const provider = new MockEmbeddingProvider();
    const result = await provider.embed([]);
    expect(result.vectors).toEqual([]);
    expect(result.usage?.prompt_tokens).toBe(0);
  });
});

describe("packFloat32 / unpackFloat32", () => {
  it("round-trips a vector exactly", () => {
    const vec = Float32Array.from([0.1, -0.2, 1e-7, 1.5, 0]);
    const packed = packFloat32(vec);
    expect(packed.byteLength).toBe(vec.byteLength);
    const restored = unpackFloat32(packed);
    expect(Array.from(restored)).toEqual(Array.from(vec));
  });

  it("packed buffer is independent of the source view", () => {
    const vec = Float32Array.from([1, 2, 3]);
    const packed = packFloat32(vec);
    vec[0] = 99;
    const restored = unpackFloat32(packed);
    expect(restored[0]).toBe(1); // packed copy was taken pre-mutation
  });
});

describe("cosine", () => {
  it("returns 1 for identical vectors", () => {
    const a = Float32Array.from([1, 2, 3]);
    expect(cosine(a, a)).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([0, 1]);
    expect(cosine(a, b)).toBeCloseTo(0, 6);
  });

  it("returns 0 for a zero-norm vector (no NaN)", () => {
    const a = Float32Array.from([0, 0, 0]);
    const b = Float32Array.from([1, 0, 0]);
    expect(cosine(a, b)).toBe(0);
    expect(Number.isFinite(cosine(a, b))).toBe(true);
  });

  it("throws on dim mismatch", () => {
    const a = Float32Array.from([1, 2]);
    const b = Float32Array.from([1, 2, 3]);
    expect(() => cosine(a, b)).toThrow(/dim mismatch/);
  });
});
