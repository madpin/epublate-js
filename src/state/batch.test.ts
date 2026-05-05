import { afterEach, describe, expect, it } from "vitest";

import { useBatchStore } from "./batch";
import { createSummary } from "@/core/batch";

afterEach(() => {
  // Reset the singleton between tests so a stale active/queue from a
  // previous case doesn't bleed across.
  useBatchStore.setState({ active: null, queue: [] });
});

describe("useBatchStore queue", () => {
  it("is empty by default", () => {
    expect(useBatchStore.getState().queue).toEqual([]);
  });

  it("FIFO enqueue/dequeue cycle", () => {
    const s = useBatchStore.getState();
    s.enqueue({
      id: "a",
      project_id: "p1",
      project_name: "Book A",
      enqueued_at: 1,
      label: "1 chapter",
      input: { project_id: "p1" },
    });
    s.enqueue({
      id: "b",
      project_id: "p2",
      project_name: "Book B",
      enqueued_at: 2,
      label: "all pending",
      input: { project_id: "p2" },
    });

    expect(useBatchStore.getState().queue).toHaveLength(2);

    const first = useBatchStore.getState().dequeue();
    expect(first?.id).toBe("a");
    expect(useBatchStore.getState().queue).toHaveLength(1);

    const second = useBatchStore.getState().dequeue();
    expect(second?.id).toBe("b");
    expect(useBatchStore.getState().queue).toHaveLength(0);

    expect(useBatchStore.getState().dequeue()).toBeNull();
  });

  it("removeQueued / clearQueue", () => {
    const s = useBatchStore.getState();
    s.enqueue({
      id: "x",
      project_id: "p",
      project_name: "X",
      enqueued_at: 1,
      label: "1",
      input: {},
    });
    s.enqueue({
      id: "y",
      project_id: "p",
      project_name: "Y",
      enqueued_at: 2,
      label: "1",
      input: {},
    });

    useBatchStore.getState().removeQueued("x");
    expect(useBatchStore.getState().queue.map((q) => q.id)).toEqual(["y"]);

    useBatchStore.getState().clearQueue();
    expect(useBatchStore.getState().queue).toEqual([]);
  });

  it("does not start when an active batch is already running", () => {
    const summary = createSummary();
    useBatchStore.getState().start({
      project_id: "p",
      project_name: "P",
      summary,
      controller: new AbortController(),
    });
    expect(useBatchStore.getState().active?.finished).toBe(false);
  });
});
