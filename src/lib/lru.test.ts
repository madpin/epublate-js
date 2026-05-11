import { describe, expect, it } from "vitest";

import { Lru } from "@/lib/lru";

describe("Lru", () => {
  it("rejects non-positive maxSize", () => {
    expect(() => new Lru<string, number>(0)).toThrow();
    expect(() => new Lru<string, number>(-1)).toThrow();
    expect(() => new Lru<string, number>(Number.NaN)).toThrow();
  });

  it("stores and retrieves values", () => {
    const c = new Lru<string, number>(3);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBe(2);
    expect(c.size).toBe(2);
  });

  it("promotes accessed entries (LRU recency)", () => {
    const c = new Lru<string, number>(3);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    // Touching "a" promotes it to MRU; next insertion evicts "b".
    c.get("a");
    c.set("d", 4);
    expect(c.has("a")).toBe(true);
    expect(c.has("b")).toBe(false);
    expect(c.has("c")).toBe(true);
    expect(c.has("d")).toBe(true);
  });

  it("evicts the LRU entry on overflow when no promotions happened", () => {
    const c = new Lru<string, number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3); // evicts "a"
    expect(c.has("a")).toBe(false);
    expect(c.has("b")).toBe(true);
    expect(c.has("c")).toBe(true);
  });

  it("re-inserting an existing key resets its recency", () => {
    const c = new Lru<string, number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.set("a", 99); // overwrite — a becomes MRU
    c.set("c", 3); // evicts b, not a
    expect(c.has("a")).toBe(true);
    expect(c.get("a")).toBe(99);
    expect(c.has("b")).toBe(false);
  });

  it("clear() drops entries and resets stats", () => {
    const c = new Lru<string, number>(2);
    c.set("a", 1);
    c.get("a");
    c.get("missing");
    expect(c.stats()).toEqual({ hits: 1, misses: 1, size: 1 });
    c.clear();
    expect(c.stats()).toEqual({ hits: 0, misses: 0, size: 0 });
  });

  it("tracks hit/miss counters", () => {
    const c = new Lru<string, number>(2);
    c.set("a", 1);
    c.get("a");
    c.get("a");
    c.get("b");
    expect(c.stats()).toEqual({ hits: 2, misses: 1, size: 1 });
  });
});
