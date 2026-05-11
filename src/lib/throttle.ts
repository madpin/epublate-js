/**
 * Cooperative async throttle with a mutable cap.
 *
 * A worker pool can spawn `N` concurrent workers but gate their work
 * behind a single throttle so the *effective* in-flight count never
 * exceeds the current cap. Callers `acquire()` before doing work and
 * `release()` after. The cap can be raised or lowered at any time —
 * raising it wakes parked waiters up to the new ceiling; lowering it
 * is enforced lazily as in-flight tasks finish.
 *
 * Used by `src/core/batch.ts` to back off concurrency when an
 * OpenAI-compatible provider reports a low
 * `x-ratelimit-remaining-requests`. The user's configured concurrency
 * is the upper bound — the throttle never amplifies, only attenuates.
 *
 * Properties (asserted by `throttle.test.ts`):
 *
 * - At most `cap` tasks hold a slot at any time.
 * - Lowering the cap never strands waiters: every parked acquire
 *   eventually returns, even if the cap is dropped while it waits
 *   and later raised again.
 * - Releasing wakes at most one waiter — strictly serialized FIFO
 *   so the queue doesn't starve.
 */
export class Throttle {
  private cap: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(initialCap: number) {
    if (!Number.isFinite(initialCap) || initialCap < 1) {
      throw new RangeError(
        `Throttle: cap must be a positive integer (got ${initialCap})`,
      );
    }
    this.cap = Math.max(1, Math.trunc(initialCap));
  }

  get currentCap(): number {
    return this.cap;
  }

  get inFlight(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Block until a slot is free, then claim it. Callers MUST pair every
   * resolved `acquire()` with exactly one `release()` (typically in a
   * `finally`). Concurrent acquires are served FIFO.
   */
  async acquire(): Promise<void> {
    // Loop because the cap could have shrunk between wakeup and resume.
    while (this.active >= this.cap) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
  }

  /** Return a slot. Wakes the next FIFO waiter, if any. */
  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  /**
   * Update the cap.
   *
   * Floors at 1 — we never serialize completely; the user's batch
   * keeps making forward progress even at maximum attenuation. The
   * cap is clamped on the way in so callers can pass raw provider
   * signals without pre-sanitising.
   *
   * Raising the cap wakes parked acquires up to the new ceiling.
   * Lowering it never preempts in-flight work — those tasks complete
   * normally and the new ceiling kicks in on the next `acquire`.
   */
  setCap(newCap: number): void {
    if (!Number.isFinite(newCap)) return;
    const clamped = Math.max(1, Math.trunc(newCap));
    const old = this.cap;
    this.cap = clamped;
    if (clamped > old) {
      // Wake up enough waiters to fill the additional capacity. Each
      // wakeup re-checks `active >= cap` in `acquire` so a no-longer-
      // hungry waiter just goes back to sleep.
      const wakeups = Math.min(
        this.waiters.length,
        Math.max(0, clamped - this.active),
      );
      for (let i = 0; i < wakeups; i += 1) {
        const w = this.waiters.shift();
        if (w) w();
      }
    }
  }

  /**
   * Wake every waiter immediately — useful when the orchestrator
   * decides to drain (cancel, pause, end-of-work). Waiters re-check
   * their preconditions and exit gracefully.
   */
  drainWaiters(): void {
    const all = this.waiters.splice(0, this.waiters.length);
    for (const w of all) w();
  }
}
