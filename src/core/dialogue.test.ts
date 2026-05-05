import { describe, expect, it } from "vitest";

import { isContextMode, isDialogueSegment } from "./dialogue";

describe("isDialogueSegment", () => {
  it("flags ASCII straight-quote dialogue", () => {
    expect(isDialogueSegment('"Hello," he said.')).toBe(true);
    expect(isDialogueSegment('She whispered, "I know."')).toBe(true);
  });

  it("flags curly-quote dialogue", () => {
    expect(isDialogueSegment("\u201CHello,\u201D he said.")).toBe(true);
  });

  it("flags Japanese corner-bracket dialogue", () => {
    expect(isDialogueSegment("\u300C\u3053\u3093\u306B\u3061\u306F\u300D")).toBe(true);
    expect(isDialogueSegment("\u300E\u4F4F\u3093\u3067\u3044\u305F\u3068\u3053\u308D\u300F")).toBe(true);
  });

  it("flags French/Spanish em-dash speech leaders", () => {
    expect(isDialogueSegment("\u2014 Bonjour, dit-il.")).toBe(true);
    expect(isDialogueSegment("  \u2015 \u3053\u3093\u306B\u3061\u306F")).toBe(true);
  });

  it("flags guillemet quotes", () => {
    expect(isDialogueSegment("\u00ABBonjour\u00BB")).toBe(true);
  });

  it("ignores non-dialogue narrative prose", () => {
    expect(isDialogueSegment("It was a dark and stormy night.")).toBe(false);
    expect(isDialogueSegment("Tom-John was running.")).toBe(false);
    expect(isDialogueSegment("    ")).toBe(false);
  });

  it("treats an em-dash mid-word as non-dialogue", () => {
    expect(isDialogueSegment("prompt \u2014 engineering")).toBe(false);
  });

  it("treats null/undefined/empty as non-dialogue", () => {
    expect(isDialogueSegment(null)).toBe(false);
    expect(isDialogueSegment(undefined)).toBe(false);
    expect(isDialogueSegment("")).toBe(false);
  });
});

describe("isContextMode", () => {
  it("accepts the three known modes", () => {
    expect(isContextMode("off")).toBe(true);
    expect(isContextMode("previous")).toBe(true);
    expect(isContextMode("dialogue")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isContextMode("conversation")).toBe(false);
    expect(isContextMode(null)).toBe(false);
    expect(isContextMode(undefined)).toBe(false);
    expect(isContextMode(0)).toBe(false);
  });
});
