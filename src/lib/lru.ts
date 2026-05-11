/**
 * Bounded least-recently-used cache.
 *
 * Backed by `Map`, which iterates in insertion order. We promote on
 * `get` (delete + re-set) so the iteration order tracks recency, then
 * evict the oldest key whenever `size` exceeds `maxSize`.
 *
 * Use cases in this codebase:
 *
 * - `src/glossary/matcher.ts` — compiled glossary regexes keyed by
 *   sorted, deduped term lists.
 * - `src/formats/epub/entities.ts` — pre-parse XHTML entity expansion
 *   keyed by raw chapter bytes.
 *
 * Generic, dependency-free. No expiration, no TTL, no async. Callers
 * that need those layers can wrap.
 */
export class Lru<K, V> {
  private readonly store = new Map<K, V>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxSize: number) {
    if (!Number.isFinite(maxSize) || maxSize < 1) {
      throw new RangeError(`Lru: maxSize must be a positive integer (got ${maxSize})`);
    }
  }

  /** Look up `key`; on a hit, promote to most-recently-used. */
  get(key: K): V | undefined {
    const value = this.store.get(key);
    if (value === undefined) {
      // Defensive: `Map` can technically hold `undefined` values.
      // We re-check `has` so a stored `undefined` still counts as hit
      // — which keeps semantics intuitive even though we don't use
      // that pattern today.
      if (!this.store.has(key)) {
        this.misses += 1;
        return undefined;
      }
    }
    this.hits += 1;
    // Promote: delete + re-insert lands the key at the tail
    // (most-recent) of the insertion order.
    this.store.delete(key);
    this.store.set(key, value as V);
    return value;
  }

  /** Insert or overwrite `key → value`, evicting the LRU entry if full. */
  set(key: K, value: V): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, value);
    if (this.store.size > this.maxSize) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  get size(): number {
    return this.store.size;
  }

  /** Drop everything. Useful for tests and for explicit invalidation. */
  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Read-only counters. Production code must not branch on these —
   * they exist for benchmarks and an eventual in-app perf panel.
   */
  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.store.size };
  }
}
