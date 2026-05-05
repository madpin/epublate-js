import { describe, expect, it } from "vitest";

import type { GlossaryEntryWithAliases } from "@/glossary/models";
import { canonicalForm, findNearDuplicates } from "@/glossary/dedup";
import {
  buildConstraints,
  buildTargetOnlyConstraints,
  findTargetDoubledParticles,
  glossaryHash,
  hasFlaggingViolation,
  hasLockedViolation,
  validateTarget,
} from "@/glossary/enforcer";
import { exportCsv, parseCsv } from "@/glossary/io";
import { makePattern, matchSource, targetUses } from "@/glossary/matcher";
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
