import { beforeEach, describe, expect, it } from "vitest";

import {
  __getEntityCacheStats,
  __resetEntityCacheForTests,
  expandNamedEntities,
  XHTML_NAMED_ENTITIES,
} from "@/formats/epub/entities";

describe("entities.expandNamedEntities", () => {
  beforeEach(() => {
    __resetEntityCacheForTests();
  });

  it("expands named entities to their Unicode characters", () => {
    expect(expandNamedEntities("&nbsp;")).toBe("\u00a0");
    expect(expandNamedEntities("&copy; 2026")).toBe("\u00a9 2026");
    expect(expandNamedEntities("&mdash;")).toBe("\u2014");
  });

  it("leaves the five predefined XML entities alone (DOMParser handles them)", () => {
    expect(expandNamedEntities("&amp;")).toBe("&amp;");
    expect(expandNamedEntities("&lt;")).toBe("&lt;");
    expect(expandNamedEntities("&gt;")).toBe("&gt;");
    expect(expandNamedEntities("&quot;")).toBe("&quot;");
    expect(expandNamedEntities("&apos;")).toBe("&apos;");
  });

  it("leaves unknown entities intact so the parser can complain", () => {
    expect(expandNamedEntities("&doesnotexist;")).toBe("&doesnotexist;");
  });

  it("exposes a stable table for downstream consumers", () => {
    // Spot-check the small but important Latin-1 subset that's load-
    // bearing in real ePubs. If this drifts we'd silently lose
    // round-trip fidelity for legacy XHTML 1.1 content.
    expect(XHTML_NAMED_ENTITIES.nbsp).toBe("\u00a0");
    expect(XHTML_NAMED_ENTITIES.eacute).toBe("\u00e9");
    expect(XHTML_NAMED_ENTITIES.rsquo).toBe("\u2019");
  });
});

describe("entities.expandNamedEntities cache", () => {
  beforeEach(() => {
    __resetEntityCacheForTests();
  });

  it("returns the same string the second time without rescanning", () => {
    const xml = "<p>Caf&eacute; &copy;2026</p>";
    const a = expandNamedEntities(xml);
    const b = expandNamedEntities(xml);
    expect(b).toBe(a);
    const stats = __getEntityCacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
  });

  it("distinguishes different inputs", () => {
    expandNamedEntities("<p>&copy; A</p>");
    expandNamedEntities("<p>&copy; B</p>");
    const stats = __getEntityCacheStats();
    expect(stats.misses).toBe(2);
    expect(stats.hits).toBe(0);
  });

  it("caps the cache to the configured size (LRU evicts the oldest)", () => {
    // The cap is 16 in the production module. Fill past it and the
    // first inserted entry must no longer hit.
    for (let i = 0; i < 20; i += 1) {
      expandNamedEntities(`<p>chapter ${i} &copy;</p>`);
    }
    expandNamedEntities(`<p>chapter 0 &copy;</p>`); // evicted → miss
    const stats = __getEntityCacheStats();
    // 20 unique inputs + 1 re-call of the evicted first one = 21 misses
    expect(stats.misses).toBe(21);
    expect(stats.hits).toBe(0);
    expect(stats.size).toBeLessThanOrEqual(16);
  });

  it("preserves byte-equivalent output across cached and uncached paths", () => {
    const xml = "<p>&mdash;&hellip;&trade;</p>";
    __resetEntityCacheForTests();
    const fresh = expandNamedEntities(xml);
    const reused = expandNamedEntities(xml);
    // Should be exactly the same string by both value and identity.
    expect(reused).toBe(fresh);
    expect(reused).toStrictEqual(fresh);
  });
});
