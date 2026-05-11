import { beforeEach, describe, expect, it } from "vitest";

import type { GlossaryEntryWithAliases } from "@/glossary/models";
import {
  canonicalForm,
  findEmbeddingDuplicates,
  findNearDuplicates,
} from "@/glossary/dedup";
import { packFloat32 } from "@/llm/embeddings/base";
import type { EmbeddingRow } from "@/db/schema";
import {
  buildConstraints,
  buildProposedHints,
  buildTargetOnlyConstraints,
  findTargetDoubledParticles,
  glossaryHash,
  hasFlaggingViolation,
  hasLockedViolation,
  validateTarget,
} from "@/glossary/enforcer";
import { exportCsv, parseCsv } from "@/glossary/io";
import {
  __getMatcherStats,
  __resetMatcherCacheForTests,
  makePattern,
  matchSource,
  targetUses,
} from "@/glossary/matcher";
import {
  analyzePair,
  findDoubledParticles,
  leadingParticle,
  normalizeTerm,
} from "@/glossary/normalize";

function fakeEntry(input: {
  id?: string;
  source_term: string | null;
  target_term: string;
  status?: "proposed" | "confirmed" | "locked";
  type?: "term" | "character" | "place";
  source_aliases?: string[];
  target_aliases?: string[];
  source_known?: boolean;
}): GlossaryEntryWithAliases {
  const id = input.id ?? `e-${Math.random().toString(36).slice(2)}`;
  return {
    entry: {
      id,
      project_id: "p",
      type: input.type ?? "term",
      source_term: input.source_term,
      target_term: input.target_term,
      gender: null,
      status: input.status ?? "confirmed",
      notes: null,
      first_seen_segment_id: null,
      created_at: 0,
      updated_at: 0,
      source_known: input.source_known ?? input.source_term !== null,
    },
    source_aliases: input.source_aliases ?? [],
    target_aliases: input.target_aliases ?? [],
  };
}

describe("normalize.leadingParticle", () => {
  it("returns null for single-token entries", () => {
    expect(leadingParticle("the", { lang: "en" })).toBeNull();
  });
  it("recognizes English the/a/an", () => {
    expect(leadingParticle("the USA", { lang: "en" })).toBe("the");
    expect(leadingParticle("an apple", { lang: "en" })).toBe("an");
  });
  it("recognizes Portuguese contractions", () => {
    expect(leadingParticle("na Europa", { lang: "pt" })).toBe("na");
    expect(leadingParticle("os EUA", { lang: "pt" })).toBe("os");
  });
  it("returns null when the leading word isn't a particle", () => {
    expect(leadingParticle("Big Apple", { lang: "en" })).toBeNull();
  });
});

describe("normalize.normalizeTerm", () => {
  it("strips a leading article", () => {
    const out = normalizeTerm("the USA", { lang: "en" });
    expect(out.particle).toBe("the");
    expect(out.stripped).toBe("USA");
  });
  it("leaves lemma forms alone", () => {
    const out = normalizeTerm("Europa", { lang: "pt" });
    expect(out.particle).toBeNull();
    expect(out.stripped).toBe("Europa");
  });
});

describe("normalize.analyzePair", () => {
  it("reports symmetric lemma pairs as ok", () => {
    const r = analyzePair({
      source_term: "Europe",
      target_term: "Europa",
      source_lang: "en",
      target_lang: "pt",
    });
    expect(r.symmetric).toBe(true);
  });
  it("reports symmetric article-on-both-sides pairs as ok", () => {
    const r = analyzePair({
      source_term: "the USA",
      target_term: "os EUA",
      source_lang: "en",
      target_lang: "pt",
    });
    expect(r.symmetric).toBe(true);
  });
  it("rejects target-leading-particle without source equivalent", () => {
    const r = analyzePair({
      source_term: "Europe",
      target_term: "na Europa",
      source_lang: "en",
      target_lang: "pt",
    });
    expect(r.symmetric).toBe(false);
    expect(r.message).toContain("target");
  });
});

describe("normalize.findDoubledParticles", () => {
  it("flags na na", () => {
    const out = findDoubledParticles("Na na Europa, há…", { lang: "pt" });
    expect(out.length).toBe(1);
    expect(out[0]![0]).toBe("na");
  });
  it("ignores cross-sentence boundaries", () => {
    const out = findDoubledParticles("In. In", { lang: "en" });
    expect(out.length).toBe(0);
  });
});

describe("matcher.makePattern", () => {
  it("returns null on empty", () => {
    expect(makePattern([])).toBeNull();
  });
  it("escapes regex metacharacters", () => {
    const re = makePattern(["a.b"]);
    expect(re).not.toBeNull();
    expect(re!.exec("a.b")).not.toBeNull();
    re!.lastIndex = 0;
    expect(re!.exec("axb")).toBeNull();
  });
  it("matches longer terms first via length-desc sort", () => {
    const re = makePattern(["Eli", "Elise"])!;
    re.lastIndex = 0;
    const m = re.exec("Elise stood")!;
    expect(m[0]).toBe("Elise");
  });
});

describe("matcher.matchSource", () => {
  const eli = fakeEntry({
    source_term: "Élise",
    target_term: "Élise",
    source_aliases: ["Eli"],
  });
  it("finds Unicode source spans", () => {
    const out = matchSource("Élise stood; Eli waved.", [eli]);
    expect(out).toHaveLength(2);
    expect(out[0]!.term).toBe("Élise");
    expect(out[1]!.term).toBe("Eli");
  });
  it("respects word boundaries", () => {
    const out = matchSource("Elise was elsewhere.", [eli]);
    expect(out).toHaveLength(0);
  });
});

describe("matcher.makePattern cache", () => {
  // Reset before each assertion so we can read clean counters. The
  // cache is module-scope and survives across tests by design — these
  // checks rely on the reset hook to keep their accounting honest.
  beforeEach(() => {
    __resetMatcherCacheForTests();
  });

  it("compiles a regex only on the first call for identical input", () => {
    const terms = ["alpha", "beta", "gamma"];
    const r1 = makePattern(terms);
    const r2 = makePattern(terms);
    const r3 = makePattern([...terms]); // different array, same content
    // Same shared `RegExp` instance handed back on each hit.
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    const stats = __getMatcherStats();
    expect(stats.compile_count).toBe(1);
    expect(stats.cache_hit_count).toBe(2);
  });

  it("normalizes term order + duplicates so calls with the same set share a regex", () => {
    const a = makePattern(["alpha", "beta"]);
    const b = makePattern(["beta", "alpha"]);
    const c = makePattern(["alpha", "alpha", "beta"]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(__getMatcherStats().compile_count).toBe(1);
  });

  it("compiles distinct regexes for different term sets", () => {
    const a = makePattern(["one"]);
    const b = makePattern(["two"]);
    expect(a).not.toBe(b);
    expect(__getMatcherStats().compile_count).toBe(2);
  });

  it("does not cache the empty case", () => {
    expect(makePattern([])).toBeNull();
    expect(makePattern([""])).toBeNull();
    expect(__getMatcherStats().compile_count).toBe(0);
    expect(__getMatcherStats().cache_hit_count).toBe(0);
  });

  it("matchSource over a many-entry glossary compiles each entry's pattern exactly once across two passes", () => {
    // Simulate the pipeline's hot loop: pre-call constraints + post-
    // call validation run `matchSource` twice per segment over the
    // full project glossary. Without the cache we'd see N compiles
    // on the first pass and N more on the second. With the cache we
    // see N compiles total and N hits on the second pass.
    const entries: GlossaryEntryWithAliases[] = [];
    for (let i = 0; i < 50; i += 1) {
      entries.push(
        fakeEntry({
          id: `e-${i}`,
          source_term: `Term${i}`,
          target_term: `t${i}`,
        }),
      );
    }
    matchSource("nothing matches here", entries);
    expect(__getMatcherStats().compile_count).toBe(50);
    expect(__getMatcherStats().cache_hit_count).toBe(0);
    // Second pass over the same glossary — every entry hits the cache.
    matchSource("still nothing matches", entries);
    expect(__getMatcherStats().compile_count).toBe(50);
    expect(__getMatcherStats().cache_hit_count).toBe(50);
  });

  it("targetUses hits the same cache (shared key space) when source aliases happen to coincide", () => {
    const ent = fakeEntry({
      source_term: "Câmara",
      target_term: "Câmara",
    });
    matchSource("A Câmara votou.", [ent]); // compiles for ["Câmara"]
    targetUses("A Câmara votou.", ent); // same canonical key
    const stats = __getMatcherStats();
    expect(stats.compile_count).toBe(1);
    expect(stats.cache_hit_count).toBeGreaterThanOrEqual(1);
  });

  it("preserves longest-first / Unicode-boundary semantics on a cache hit", () => {
    // Confirm we're returning the same `RegExp` *and* it still
    // honours the original semantics — paranoia against a refactor
    // that ever drops the length-desc sort.
    const re1 = makePattern(["Eli", "Elise"])!;
    const re2 = makePattern(["Eli", "Elise"])!;
    expect(re1).toBe(re2);
    re1.lastIndex = 0;
    const m = re1.exec("Elise stood, Eli waved.")!;
    expect(m[0]).toBe("Elise");
  });
});

describe("matcher.targetUses", () => {
  const ent = fakeEntry({
    source_term: "House",
    target_term: "Câmara",
    target_aliases: ["Câmara dos Lordes"],
  });
  it("matches canonical target", () => {
    expect(targetUses("a Câmara votou", ent)).toBe(true);
  });
  it("matches an alias", () => {
    expect(targetUses("a Câmara dos Lordes votou", ent)).toBe(true);
  });
  it("is case-sensitive", () => {
    expect(targetUses("a câmara votou", ent)).toBe(false);
  });
});

describe("enforcer.buildConstraints", () => {
  it("drops proposed entries", () => {
    const e = [
      fakeEntry({
        source_term: "X",
        target_term: "Y",
        status: "proposed",
      }),
      fakeEntry({
        source_term: "A",
        target_term: "B",
        status: "locked",
      }),
    ];
    const out = buildConstraints(e);
    expect(out).toHaveLength(1);
    expect(out[0]!.source_term).toBe("A");
  });
  it("orders locked before confirmed and alphabetically", () => {
    const e = [
      fakeEntry({ source_term: "Z", target_term: "z", status: "confirmed" }),
      fakeEntry({ source_term: "A", target_term: "a", status: "confirmed" }),
      fakeEntry({ source_term: "B", target_term: "b", status: "locked" }),
    ];
    const out = buildConstraints(e);
    expect(out.map((x) => x.source_term)).toEqual(["B", "A", "Z"]);
  });
});

describe("enforcer.buildTargetOnlyConstraints", () => {
  it("includes only target-only entries", () => {
    const e = [
      fakeEntry({
        source_term: null,
        target_term: "Câmara",
        status: "locked",
        source_known: false,
      }),
      fakeEntry({ source_term: "House", target_term: "Câmara", status: "locked" }),
    ];
    const out = buildTargetOnlyConstraints(e);
    expect(out).toHaveLength(1);
    expect(out[0]!.target_term).toBe("Câmara");
  });
});

describe("enforcer.buildProposedHints", () => {
  it("returns an empty block when no proposed entries qualify", () => {
    const out = buildProposedHints({
      entries: [
        fakeEntry({
          source_term: "wolf",
          target_term: "lobo",
          status: "confirmed",
        }),
      ],
      similarities: new Map([["e-1", 0.9]]),
    });
    expect(out.block).toBe("");
    expect(out.used_ids).toEqual([]);
  });

  it("filters proposed entries by min_similarity and caps at top_k", () => {
    const high = fakeEntry({
      id: "high",
      source_term: "wolf",
      target_term: "lobo",
      status: "proposed",
    });
    const mid = fakeEntry({
      id: "mid",
      source_term: "moon",
      target_term: "lua",
      status: "proposed",
    });
    const low = fakeEntry({
      id: "low",
      source_term: "fog",
      target_term: "neblina",
      status: "proposed",
    });
    const sims = new Map([
      ["high", 0.95],
      ["mid", 0.81],
      ["low", 0.5],
    ]);
    const out = buildProposedHints({
      entries: [high, mid, low],
      similarities: sims,
      top_k: 2,
      min_similarity: 0.7,
    });
    expect(out.used_ids.sort()).toEqual(["high", "mid"]);
    // Phase 1: `buildProposedHints` returns body lines only — the
    // surrounding `<proposed_terms unvetted="true">` wrapper is added
    // by `buildTranslatorMessages` so the user-message portion of the
    // cache key stays minimal.
    expect(out.block).not.toContain("Proposed terms (unvetted hints)");
    expect(out.block).toContain("wolf → lobo");
    expect(out.block).toContain("moon → lua");
    expect(out.block).not.toContain("fog");
  });

  it("never includes locked or confirmed entries even when similarity is high", () => {
    const proposed = fakeEntry({
      id: "p1",
      source_term: "p",
      target_term: "P",
      status: "proposed",
    });
    const confirmed = fakeEntry({
      id: "c1",
      source_term: "c",
      target_term: "C",
      status: "confirmed",
    });
    const out = buildProposedHints({
      entries: [proposed, confirmed],
      similarities: new Map([
        ["p1", 0.9],
        ["c1", 0.99],
      ]),
    });
    expect(out.used_ids).toEqual(["p1"]);
    expect(out.block).not.toContain("c → C");
  });

  it("renders entries deterministically by source term so the cache key stays stable", () => {
    const a = fakeEntry({
      id: "a",
      source_term: "alpha",
      target_term: "alfa",
      status: "proposed",
    });
    const b = fakeEntry({
      id: "b",
      source_term: "beta",
      target_term: "beta",
      status: "proposed",
    });
    const sims = new Map([
      ["a", 0.9],
      ["b", 0.91],
    ]);
    const order_a = buildProposedHints({
      entries: [a, b],
      similarities: sims,
    });
    const order_b = buildProposedHints({
      entries: [b, a],
      similarities: sims,
    });
    expect(order_a.block).toBe(order_b.block);
    // Source-sorted: alpha appears before beta in both runs.
    expect(order_a.block.indexOf("alpha")).toBeLessThan(
      order_a.block.indexOf("beta"),
    );
  });

  it("returns an empty block when top_k <= 0", () => {
    const e = fakeEntry({
      id: "x",
      source_term: "foo",
      target_term: "fu",
      status: "proposed",
    });
    const out = buildProposedHints({
      entries: [e],
      similarities: new Map([["x", 0.99]]),
      top_k: 0,
    });
    expect(out.block).toBe("");
    expect(out.used_ids).toEqual([]);
  });
});

describe("enforcer.validateTarget", () => {
  it("flags missing locked target as error", () => {
    const e = [
      fakeEntry({
        source_term: "House",
        target_term: "Câmara",
        status: "locked",
      }),
    ];
    const violations = validateTarget({
      source_text: "The House voted.",
      target_text: "A casa votou.",
      entries: e,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.severity).toBe("error");
    expect(hasLockedViolation(violations)).toBe(true);
    expect(hasFlaggingViolation(violations)).toBe(true);
  });

  it("warns on missing confirmed target", () => {
    const e = [
      fakeEntry({
        source_term: "House",
        target_term: "Câmara",
        status: "confirmed",
      }),
    ];
    const violations = validateTarget({
      source_text: "The House voted.",
      target_text: "A casa votou.",
      entries: e,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.severity).toBe("warning");
    expect(hasLockedViolation(violations)).toBe(false);
    // Confirmed-only warnings don't flag
    expect(hasFlaggingViolation(violations)).toBe(false);
  });

  it("downgrades target-only locked to warning", () => {
    const e = [
      fakeEntry({
        source_term: null,
        target_term: "Câmara",
        status: "locked",
        source_known: false,
      }),
    ];
    const violations = validateTarget({
      source_text: "Câmara is target-only — match by alias.",
      target_text: "Casa votou.",
      entries: e,
    });
    // No source-side match => no violation surfaced
    expect(violations).toHaveLength(0);
  });
});

describe("enforcer.findTargetDoubledParticles", () => {
  it("flags na na", () => {
    const v = findTargetDoubledParticles("Na na Europa, há…", { target_lang: "pt" });
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe("doubled_particle");
    expect(hasFlaggingViolation(v)).toBe(true);
  });
});

describe("enforcer.glossaryHash", () => {
  it("is stable across re-orderings", async () => {
    const a = fakeEntry({
      id: "1",
      source_term: "Foo",
      target_term: "Bar",
    });
    const b = fakeEntry({
      id: "2",
      source_term: "Baz",
      target_term: "Qux",
    });
    const h1 = await glossaryHash([a, b]);
    const h2 = await glossaryHash([b, a]);
    expect(h1).toBe(h2);
  });
  it("changes when a target term changes", async () => {
    const a = fakeEntry({
      id: "1",
      source_term: "Foo",
      target_term: "Bar",
    });
    const ap = { ...a, entry: { ...a.entry, target_term: "Baz" } };
    const h1 = await glossaryHash([a]);
    const h2 = await glossaryHash([ap]);
    expect(h1).not.toBe(h2);
  });
});

describe("dedup.canonicalForm", () => {
  it("strips trailing acronym suffixes", () => {
    expect(canonicalForm("Heavily Indebted Poor Country (HIPC) initiative"))
      .toBe("heavily indebted poor country");
  });
  it("handles broken parens", () => {
    expect(canonicalForm("FIFA (")).toBe("fifa");
  });
  it("normalizes case + whitespace", () => {
    expect(canonicalForm("  House Lannister  ")).toBe("house lannister");
  });
});

describe("dedup.findNearDuplicates", () => {
  it("groups exact canonical bucket dupes", () => {
    const a = fakeEntry({ id: "1", source_term: "FIFA", target_term: "FIFA" });
    // Trailing broken paren — canonical_form strips it.
    const b = fakeEntry({ id: "2", source_term: "FIFA (", target_term: "FIFA" });
    const groups = findNearDuplicates([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((e) => e.entry.id)).toEqual(["1", "2"]);
  });
  it("drops singletons", () => {
    const a = fakeEntry({ id: "1", source_term: "Solo", target_term: "Sol" });
    expect(findNearDuplicates([a])).toEqual([]);
  });
});

describe("dedup.findEmbeddingDuplicates", () => {
  function vec(values: number[]): Float32Array {
    return Float32Array.from(values);
  }
  function row(
    ref_id: string,
    values: number[],
    model = "test-emb",
  ): EmbeddingRow {
    const v = vec(values);
    return {
      id: `r-${ref_id}`,
      scope: "glossary_entry",
      ref_id,
      model,
      dim: v.length,
      vector: packFloat32(v),
      created_at: 0,
    };
  }

  it("returns an empty array when fewer than two entries have vectors", () => {
    const a = fakeEntry({
      id: "a",
      source_term: "wolf",
      target_term: "lobo",
      status: "proposed",
    });
    expect(findEmbeddingDuplicates([a], [row("a", [1, 0, 0])])).toEqual([]);
  });

  it("clusters near-identical proposed entries into one group", () => {
    const a = fakeEntry({
      id: "a",
      source_term: "wolf",
      target_term: "lobo",
      type: "character",
      status: "proposed",
    });
    const b = fakeEntry({
      id: "b",
      source_term: "Wolf",
      target_term: "Lobo",
      type: "character",
      status: "proposed",
    });
    const c = fakeEntry({
      id: "c",
      source_term: "moon",
      target_term: "lua",
      type: "character",
      status: "proposed",
    });
    const groups = findEmbeddingDuplicates(
      [a, b, c],
      [
        row("a", [1, 0, 0, 0]),
        row("b", [0.999, 0.001, 0, 0]),
        row("c", [0, 1, 0, 0]),
      ],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members.map((m) => m.entry.id).sort()).toEqual(
      ["a", "b"],
    );
    expect(groups[0]!.max_similarity).toBeGreaterThan(0.92);
  });

  it("respects same_type_only by default", () => {
    const a = fakeEntry({
      id: "a",
      source_term: "tower",
      target_term: "torre",
      type: "place",
      status: "proposed",
    });
    const b = fakeEntry({
      id: "b",
      source_term: "Tower",
      target_term: "Torre",
      type: "character",
      status: "proposed",
    });
    const same_vec = [1, 0, 0, 0];
    expect(
      findEmbeddingDuplicates(
        [a, b],
        [row("a", same_vec), row("b", same_vec)],
      ),
    ).toEqual([]);
    // With type-coercion off, the same pair clusters.
    const groups = findEmbeddingDuplicates(
      [a, b],
      [row("a", same_vec), row("b", same_vec)],
      { same_type_only: false },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members.map((m) => m.entry.id).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("ranks confirmed/locked entries ahead of proposed ones in a cluster", () => {
    const proposed = fakeEntry({
      id: "p",
      source_term: "wolf",
      target_term: "lobo",
      type: "character",
      status: "proposed",
    });
    const confirmed = fakeEntry({
      id: "c",
      source_term: "Wolf",
      target_term: "Lobo",
      type: "character",
      status: "confirmed",
    });
    const groups = findEmbeddingDuplicates(
      [proposed, confirmed],
      [row("p", [1, 0]), row("c", [1, 0.001])],
      { min_similarity: 0.5 },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members[0]!.entry.id).toBe("c");
    expect(groups[0]!.members[1]!.entry.id).toBe("p");
  });

  it("skips entries without an embedding row", () => {
    const a = fakeEntry({
      id: "a",
      source_term: "wolf",
      target_term: "lobo",
      type: "character",
      status: "proposed",
    });
    const b = fakeEntry({
      id: "b",
      source_term: "wolf",
      target_term: "lobo",
      type: "character",
      status: "proposed",
    });
    // Only `a` has a vector — no possible cluster.
    expect(findEmbeddingDuplicates([a, b], [row("a", [1, 0])])).toEqual([]);
  });

  it("skips rows whose dim doesn't match the first observed dim", () => {
    const a = fakeEntry({
      id: "a",
      source_term: "wolf",
      target_term: "lobo",
      type: "character",
      status: "proposed",
    });
    const b = fakeEntry({
      id: "b",
      source_term: "Wolf",
      target_term: "Lobo",
      type: "character",
      status: "proposed",
    });
    // `b`'s vector is the wrong dim → it gets dropped, the cluster
    // becomes a singleton, and the function returns no groups.
    expect(
      findEmbeddingDuplicates(
        [a, b],
        [row("a", [1, 0, 0]), row("b", [1, 0])],
      ),
    ).toEqual([]);
  });
});

describe("io.exportCsv / parseCsv", () => {
  it("round-trips a simple entry", () => {
    const ent = fakeEntry({
      source_term: "House, of Commons",
      target_term: "Câmara",
      type: "place",
      source_aliases: ["Commons"],
      target_aliases: ["Câmara dos Comuns"],
    });
    const csv = exportCsv([ent]);
    const parsed = parseCsv(csv);
    expect(parsed.entries).toHaveLength(1);
    const e = parsed.entries[0]!;
    expect(e.source_term).toBe("House, of Commons");
    expect(e.target_term).toBe("Câmara");
    expect(e.type).toBe("place");
    expect(e.source_aliases).toEqual(["Commons"]);
    expect(e.target_aliases).toEqual(["Câmara dos Comuns"]);
  });
  it("supports target-only entries", () => {
    const ent = fakeEntry({
      source_term: null,
      target_term: "Câmara",
      source_known: false,
    });
    const csv = exportCsv([ent]);
    const parsed = parseCsv(csv);
    expect(parsed.entries[0]!.source_known).toBe(false);
    expect(parsed.entries[0]!.source_term).toBeNull();
  });
});
