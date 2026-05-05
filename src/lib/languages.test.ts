import { describe, expect, it } from "vitest";

import {
  canonicalizeTag,
  describeLanguage,
  findLanguage,
  isKnownLanguage,
  searchLanguages,
} from "./languages";

describe("canonicalizeTag", () => {
  it("lowercases the primary subtag and uppercases the region", () => {
    expect(canonicalizeTag("PT-br")).toBe("pt-BR");
    expect(canonicalizeTag("pt-br")).toBe("pt-BR");
    expect(canonicalizeTag("EN-US")).toBe("en-US");
  });

  it("title-cases script subtags", () => {
    expect(canonicalizeTag("zh-hans")).toBe("zh-Hans");
    expect(canonicalizeTag("zh-HANS-tw")).toBe("zh-Hans-TW");
  });

  it("preserves numeric region codes", () => {
    expect(canonicalizeTag("es-419")).toBe("es-419");
  });

  it("returns the empty string verbatim", () => {
    expect(canonicalizeTag("")).toBe("");
    expect(canonicalizeTag("   ")).toBe("");
  });
});

describe("findLanguage", () => {
  it("matches exact codes case-insensitively", () => {
    const m = findLanguage("PT-BR");
    expect(m?.code).toBe("pt-BR");
    expect(m?.name).toMatch(/Brazil/i);
  });

  it("falls back to the primary subtag when the region is unknown", () => {
    const m = findLanguage("pt-AO");
    // pt-AO is in the seed list, so we expect an exact match.
    expect(m?.code).toBe("pt-AO");

    // pt-XX is not seeded; we should fall back to `pt`.
    const fallback = findLanguage("pt-XX");
    expect(fallback?.code).toBe("pt");
  });

  it("returns null for empty input or fully unknown tags", () => {
    expect(findLanguage(null)).toBeNull();
    expect(findLanguage("")).toBeNull();
    expect(findLanguage("   ")).toBeNull();
    expect(findLanguage("xx")).toBeNull();
    expect(findLanguage("zz-yy")).toBeNull();
  });
});

describe("isKnownLanguage", () => {
  it("is true for catalogued tags", () => {
    expect(isKnownLanguage("en")).toBe(true);
    expect(isKnownLanguage("pt-BR")).toBe(true);
    // Even unseeded regions are accepted because the primary subtag
    // resolves.
    expect(isKnownLanguage("pt-XX")).toBe(true);
  });

  it("is false for empty / fully unknown tags", () => {
    expect(isKnownLanguage("")).toBe(false);
    expect(isKnownLanguage("xx")).toBe(false);
    expect(isKnownLanguage(null)).toBe(false);
  });
});

describe("describeLanguage", () => {
  it("returns the friendly name for a known exact match", () => {
    expect(describeLanguage("pt-BR")).toBe("Portuguese (Brazil)");
  });

  it("annotates a primary-fallback match", () => {
    expect(describeLanguage("pt-XX")).toBe("Portuguese (pt-XX)");
  });

  it("returns the input verbatim when nothing matches", () => {
    expect(describeLanguage("xx")).toBe("xx");
  });

  it("handles whitespace/null gracefully", () => {
    expect(describeLanguage("  ")).toBe("");
    expect(describeLanguage(null)).toBe("");
  });
});

describe("searchLanguages", () => {
  it("ranks exact matches first", () => {
    const out = searchLanguages("en");
    expect(out[0]?.code).toBe("en");
  });

  it("prefers prefix matches over substring matches", () => {
    const out = searchLanguages("port", 5).map((l) => l.code);
    expect(out[0]).toBe("pt");
    // Some "Portuguese (XYZ)" entry should appear before "Esperanto",
    // which doesn't contain "port" at all.
    expect(out.some((c) => c.startsWith("pt"))).toBe(true);
  });

  it("matches against the human-readable name", () => {
    const out = searchLanguages("brazil", 5).map((l) => l.code);
    expect(out).toContain("pt-BR");
  });

  it("returns the leading slice for empty queries", () => {
    const out = searchLanguages("", 3);
    expect(out).toHaveLength(3);
  });
});
