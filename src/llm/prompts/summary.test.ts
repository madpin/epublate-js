import { describe, expect, it } from "vitest";

import { LLMResponseError } from "@/llm/base";

import {
  buildBookSummaryMessages,
  buildChapterSummaryMessages,
  parseBookSummaryResponse,
  parseChapterSummaryResponse,
} from "./summary";

describe("buildBookSummaryMessages", () => {
  it("emits a system + user message with <source> envelope", () => {
    const msgs = buildBookSummaryMessages({
      source_lang: "en",
      target_lang: "pt",
      source_text: "Once upon a time.",
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[1]?.role).toBe("user");
    expect(msgs[1]?.content).toContain("<source>");
    expect(msgs[1]?.content).toContain("Once upon a time.");
    expect(msgs[1]?.content).toContain("</source>");
  });

  it("substitutes the source/target language tokens", () => {
    const msgs = buildBookSummaryMessages({
      source_lang: "Japanese",
      target_lang: "Brazilian Portuguese",
      source_text: "テスト。",
    });
    const sys = msgs[0]!.content as string;
    expect(sys).toContain("Japanese");
    expect(sys).toContain("Brazilian Portuguese");
    expect(sys).not.toContain("${source_lang}");
    expect(sys).not.toContain("${target_lang}");
  });

  it("includes a confirmed glossary block but skips proposed entries", () => {
    const msgs = buildBookSummaryMessages({
      source_lang: "en",
      target_lang: "pt",
      source_text: "Some text.",
      glossary: [
        {
          source_term: "wolf",
          target_term: "lobo",
          type: "term",
          status: "confirmed",
        },
        {
          source_term: "fog",
          target_term: "neblina",
          type: "term",
          status: "proposed",
        },
      ],
    });
    const sys = msgs[0]!.content as string;
    expect(sys).toContain("wolf → lobo");
    expect(sys).not.toContain("fog");
  });

  it("includes a <prior_summary> envelope when seeded", () => {
    const msgs = buildBookSummaryMessages({
      source_lang: "en",
      target_lang: "pt",
      source_text: "Some text.",
      prior_summary: "A small prince leaves his asteroid.",
    });
    const user = msgs[1]!.content as string;
    expect(user).toContain("<prior_summary>");
    expect(user).toContain("A small prince leaves his asteroid.");
    expect(user).toContain("</prior_summary>");
  });

  it("throws on empty source_text", () => {
    expect(() =>
      buildBookSummaryMessages({
        source_lang: "en",
        target_lang: "pt",
        source_text: "   ",
      }),
    ).toThrow(/must not be empty/);
  });
});

describe("parseBookSummaryResponse", () => {
  it("parses a complete response", () => {
    const trace = parseBookSummaryResponse(
      JSON.stringify({
        summary: "A small prince explores asteroids.",
        register: "literary",
        audience: "general",
        notes: null,
      }),
    );
    expect(trace.summary).toBe("A small prince explores asteroids.");
    expect(trace.register).toBe("literary");
    expect(trace.audience).toBe("general");
    expect(trace.notes).toBeNull();
  });

  it("recovers JSON when the helper wraps it in prose", () => {
    const trace = parseBookSummaryResponse(
      `Sure, here you go:\n{"summary":"Recap.","register":null,"audience":null,"notes":null}\nthanks!`,
    );
    expect(trace.summary).toBe("Recap.");
  });

  it("throws when the summary is missing", () => {
    expect(() =>
      parseBookSummaryResponse(
        JSON.stringify({ register: "literary" }),
      ),
    ).toThrow(LLMResponseError);
  });

  it("throws on empty content", () => {
    expect(() => parseBookSummaryResponse("")).toThrow(LLMResponseError);
  });

  it("throws on unparseable garbage", () => {
    expect(() => parseBookSummaryResponse("not json at all")).toThrow(
      LLMResponseError,
    );
  });
});

describe("buildChapterSummaryMessages", () => {
  it("emits a <source> envelope with optional <book_summary> + <chapter_title>", () => {
    const msgs = buildChapterSummaryMessages({
      source_lang: "en",
      target_lang: "pt",
      source_text: "Chapter one text.",
      book_summary: "A brave little prince...",
      chapter_title: "The Departure",
    });
    expect(msgs).toHaveLength(2);
    const user = msgs[1]!.content as string;
    expect(user).toContain("<book_summary>");
    expect(user).toContain("A brave little prince...");
    expect(user).toContain("<chapter_title>The Departure</chapter_title>");
    expect(user).toContain("<source>");
    expect(user).toContain("Chapter one text.");
  });

  it("omits empty optional blocks", () => {
    const msgs = buildChapterSummaryMessages({
      source_lang: "en",
      target_lang: "pt",
      source_text: "Chapter one.",
    });
    const user = msgs[1]!.content as string;
    expect(user).not.toContain("<book_summary>");
    expect(user).not.toContain("<chapter_title>");
    expect(user).toContain("<source>");
  });

  it("throws on empty source_text", () => {
    expect(() =>
      buildChapterSummaryMessages({
        source_lang: "en",
        target_lang: "pt",
        source_text: "",
      }),
    ).toThrow(/must not be empty/);
  });
});

describe("parseChapterSummaryResponse", () => {
  it("parses a complete response", () => {
    const trace = parseChapterSummaryResponse(
      JSON.stringify({
        summary: "The prince meets a fox.",
        pov_shift: null,
        scene_label: "rose garden",
      }),
    );
    expect(trace.summary).toBe("The prince meets a fox.");
    expect(trace.pov_shift).toBeNull();
    expect(trace.scene_label).toBe("rose garden");
  });

  it("throws when the summary is missing", () => {
    expect(() =>
      parseChapterSummaryResponse(JSON.stringify({ pov_shift: "first-person" })),
    ).toThrow(LLMResponseError);
  });
});
