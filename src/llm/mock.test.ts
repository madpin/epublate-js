import { describe, it, expect } from "vitest";

import { MockProvider } from "./mock";

const TRANSLATOR_SYSTEM = [
  "Inline formatting is encoded as opaque placeholders.",
  "Respond with a single JSON object.",
].join("\n");

describe("MockProvider", () => {
  it("returns deterministic translator JSON", async () => {
    const p = new MockProvider();
    const a = await p.chat({
      model: "mock-1",
      messages: [
        { role: "system", content: TRANSLATOR_SYSTEM },
        { role: "user", content: "Hello [[T0]]world[[/T0]]" },
      ],
    });
    const b = await p.chat({
      model: "mock-1",
      messages: [
        { role: "system", content: TRANSLATOR_SYSTEM },
        { role: "user", content: "Hello [[T0]]world[[/T0]]" },
      ],
    });
    expect(a.content).toEqual(b.content);
    const parsed = JSON.parse(a.content) as { target: string };
    expect(parsed.target).toContain("Hello [[T0]]world[[/T0]]");
  });

  it("falls back to a plain JSON echo for unknown system prompts", async () => {
    const p = new MockProvider();
    const r = await p.chat({
      model: "mock-1",
      messages: [
        { role: "system", content: "you are a helpful assistant" },
        { role: "user", content: "say hi" },
      ],
    });
    expect(JSON.parse(r.content)).toEqual({ target: "say hi" });
  });
});
