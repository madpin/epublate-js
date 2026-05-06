/**
 * Deterministic mock LLM provider (mirrors `epublate.llm.mock`).
 *
 * Used by tests, screenshots, and the `?mock=1` query-string demo
 * mode. Output is a function of the input prompt only — same input,
 * same output, every time, no network — so the rest of the system
 * can run without API keys and without reaching out anywhere.
 *
 * Strategy:
 *
 * - When the system prompt looks like a translator request (contains
 *   the placeholder discipline rule and the "JSON object" instruction
 *   from `prompts/translator.ts`), echo the user message back as the
 *   `target` field, prefixed with a `[mock-tr]` marker. Placeholders
 *   are preserved verbatim so the validator's "every placeholder
 *   appears once" rule passes.
 * - When it looks like an extractor request (mentions "ExtractedEntity"
 *   or the new-entities taxonomy), return an empty trace.
 * - Otherwise, echo the last user message as JSON `{"target": ..., ...}`
 *   so any caller expecting JSON gets something parseable.
 */

import {
  type ChatRequest,
  type ChatResult,
  type LLMProvider,
} from "./base";

interface MockOptions {
  /** Deterministic delay in milliseconds (UI demos look more realistic with a tiny pause). */
  delay_ms?: number;
}

export class MockProvider implements LLMProvider {
  readonly name = "mock";
  private readonly delay_ms: number;

  constructor(options: MockOptions = {}) {
    this.delay_ms = options.delay_ms ?? 0;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const t0 =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    if (this.delay_ms > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delay_ms);
        request.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }

    const sys = request.messages.find((m) => m.role === "system")?.content ?? "";
    const last_user =
      [...request.messages].reverse().find((m) => m.role === "user")?.content ??
      "";

    let content: string;
    if (this.looks_like_translator(sys)) {
      content = JSON.stringify({
        target: `[mock-tr] ${last_user}`,
        used_entries: [],
        new_entities: [],
        notes: null,
      });
    } else if (this.looks_like_group_translator(sys)) {
      const items = this.parse_group_items(last_user);
      content = JSON.stringify({
        translations: items.map((it) => ({
          id: it.id,
          target: `[mock-tr] ${it.source}`,
          used_entries: [],
          new_entities: [],
          notes: null,
        })),
        notes: null,
      });
    } else if (this.looks_like_extractor(sys)) {
      content = JSON.stringify({
        candidates: [],
        pov: null,
        tense: null,
        register: null,
        audience: null,
        notes: ["mock helper: no candidates surfaced"],
      });
    } else {
      content = JSON.stringify({ target: last_user });
    }

    const duration_ms =
      (typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now()) - t0;
    return {
      content,
      usage: {
        prompt_tokens: estimate_tokens(sys + last_user),
        completion_tokens: estimate_tokens(content),
      },
      model: request.model,
      cache_hit: false,
      raw: { mock: true, content },
      duration_ms,
    };
  }

  private looks_like_translator(system: string): boolean {
    return (
      system.includes("Inline formatting is encoded as opaque placeholders") &&
      system.includes("Respond with a single JSON object")
    );
  }

  private looks_like_group_translator(system: string): boolean {
    return (
      system.includes("BATCH of short, independent segments") &&
      system.includes('"translations"')
    );
  }

  private looks_like_extractor(system: string): boolean {
    return (
      system.includes("candidates") &&
      (system.includes("proper nouns") || system.includes("ExtractedEntity"))
    );
  }

  private parse_group_items(
    user: string,
  ): { id: number; source: string }[] {
    try {
      const parsed = JSON.parse(user) as { items?: { id: number; source: string }[] };
      return Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      return [];
    }
  }
}

function estimate_tokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}
