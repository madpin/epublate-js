import { describe, expect, it } from "vitest";

import { Throttle } from "@/lib/throttle";

/** Tiny helper to yield to the microtask queue several times. */
async function tick(n = 1): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve();
  }
}

describe("Throttle", () => {
  it("rejects non-positive caps", () => {
    expect(() => new Throttle(0)).toThrow();
    expect(() => new Throttle(-1)).toThrow();
    expect(() => new Throttle(Number.NaN)).toThrow();
  });

  it("holds at most `cap` slots at once", async () => {
    const t = new Throttle(2);
    await t.acquire();
    await t.acquire();
    let blocked = true;
    const third = t.acquire().then(() => {
      blocked = false;
    });
    await tick(5);
    expect(blocked).toBe(true);
    expect(t.inFlight).toBe(2);
    expect(t.waiting).toBe(1);
    t.release();
    await third;
    expect(blocked).toBe(false);
    expect(t.inFlight).toBe(2);
  });

  it("serves waiters FIFO", async () => {
    const t = new Throttle(1);
    await t.acquire();
    const order: number[] = [];
    const a = t.acquire().then(() => order.push(1));
    const b = t.acquire().then(() => order.push(2));
    const c = t.acquire().then(() => order.push(3));
    await tick(3);
    expect(t.waiting).toBe(3);
    t.release(); // wakes a
    await a;
    t.release(); // wakes b
    await b;
    t.release(); // wakes c
    await c;
    expect(order).toEqual([1, 2, 3]);
  });

  it("setCap(higher) wakes parked waiters up to the new ceiling", async () => {
    const t = new Throttle(1);
    await t.acquire();
    let done = 0;
    const p1 = t.acquire().then(() => done++);
    const p2 = t.acquire().then(() => done++);
    const p3 = t.acquire().then(() => done++);
    await tick(2);
    expect(done).toBe(0);
    // Raise cap to 3 → 2 additional permits (active=1 already).
    t.setCap(3);
    await Promise.all([p1, p2]);
    expect(done).toBe(2);
    expect(t.inFlight).toBe(3);
    expect(t.waiting).toBe(1);
    // The 4th task only runs after one releases.
    t.release();
    await p3;
    expect(done).toBe(3);
  });

  it("setCap(lower) is enforced lazily on next acquire", async () => {
    const t = new Throttle(3);
    await t.acquire();
    await t.acquire();
    await t.acquire();
    expect(t.inFlight).toBe(3);
    // Drop to 1: in-flight tasks aren't preempted.
    t.setCap(1);
    expect(t.inFlight).toBe(3);
    // New acquires are blocked until inFlight drops to 0.
    let acquired = false;
    const fourth = t.acquire().then(() => {
      acquired = true;
    });
    await tick(3);
    expect(acquired).toBe(false);
    // First release: inFlight = 2 → still ≥ cap=1, fourth stays blocked.
    t.release();
    await tick(3);
    expect(acquired).toBe(false);
    t.release();
    await tick(3);
    expect(acquired).toBe(false);
    t.release();
    await fourth;
    expect(acquired).toBe(true);
  });

  it("setCap floors at 1 so the worker pool never deadlocks at 0", () => {
    const t = new Throttle(5);
    t.setCap(0);
    expect(t.currentCap).toBe(1);
    t.setCap(-100);
    expect(t.currentCap).toBe(1);
  });

  it("setCap ignores NaN", () => {
    const t = new Throttle(3);
    t.setCap(Number.NaN);
    expect(t.currentCap).toBe(3);
  });

  it("drainWaiters wakes every parked acquire", async () => {
    const t = new Throttle(1);
    await t.acquire();
    let woke = 0;
    const a = t.acquire().then(() => woke++);
    const b = t.acquire().then(() => woke++);
    const c = t.acquire().then(() => woke++);
    await tick(2);
    t.drainWaiters();
    // After drain, each woken waiter still has to re-check the gate
    // (cap=1, active=1) and so re-parks itself. To see them complete
    // we release the original slot.
    t.release(); // now cap can serve waiters one at a time
    await a;
    t.release();
    await b;
    t.release();
    await c;
    expect(woke).toBe(3);
  });
});
