import { describe, expect, it, vi } from "vitest";

import { LLMError } from "@/llm/base";
import {
  explainFetchFailure,
  OpenAICompatProvider,
} from "@/llm/openai_compat";

describe("OpenAICompatProvider header hardening", () => {
  it("trims a trailing newline from the api key on construction", async () => {
    let captured_url: string | undefined;
    let captured_headers: Record<string, string> | undefined;
    const fetchImpl: typeof fetch = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        captured_url = typeof input === "string" ? input : String(input);
        captured_headers = init?.headers as Record<string, string>;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            model: "test-model",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    const provider = new OpenAICompatProvider({
      base_url: "  https://example.com/v1/  ",
      api_key: "sk-trailing-newline\n",
      default_model: "test-model",
      retry_policy: { max_retries: 0 },
      fetchImpl,
    });
    await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(captured_headers!.Authorization).toBe(
      "Bearer sk-trailing-newline",
    );
    expect(captured_url).toBe("https://example.com/v1/chat/completions");
  });

  it("rejects header values with embedded newlines / tabs", () => {
    expect(
      () =>
        new OpenAICompatProvider({
          base_url: "https://example.com/v1",
          api_key: "sk-line1\nsk-line2",
          default_model: "test-model",
        }),
    ).toThrow(LLMError);
  });

  it("rejects non-ASCII header values", () => {
    expect(
      () =>
        new OpenAICompatProvider({
          base_url: "https://example.com/v1",
          api_key: "sk-\u3042",
          default_model: "test-model",
        }),
    ).toThrow(LLMError);
  });

  it("annotates a 'Failed to execute fetch' TypeError with a hint", () => {
    const err = new TypeError(
      "Failed to execute 'fetch' on 'Window': Failed to read the 'headers' property from 'RequestInit': String contains non ISO-8859-1 code point.",
    );
    const hint = explainFetchFailure(err, "https://example.com/v1/chat/completions");
    expect(hint).toContain("stray newline");
    expect(hint).toContain("Settings");
  });

  it("annotates a 'Failed to fetch' TypeError with a CORS hint", () => {
    const err = new TypeError("Failed to fetch");
    const hint = explainFetchFailure(err, "https://api.example.com/v1/chat/completions");
    expect(hint).toContain("api.example.com");
    expect(hint).toContain("CORS");
  });

  it("rebinds the global fetch to globalThis (no 'Illegal invocation')", async () => {
    // Regression test for the exact bug a curator hit:
    // assigning `globalThis.fetch` to a class field detaches the
    // window binding, and the next call throws
    // `TypeError: Illegal invocation`. We patch `globalThis.fetch`
    // with a checker that verifies the receiver, then construct a
    // provider WITHOUT a `fetchImpl` override so the production
    // resolution path is exercised.
    const original = globalThis.fetch;
    const checker = function (
      this: unknown,
      input: URL | RequestInfo,
      init?: RequestInit,
    ): Promise<Response> {
      // The native `fetch` requires `this === window` (or
      // `globalThis`); anything else throws 'Illegal invocation'.
      // We assert the receiver here so the test fails clearly if a
      // future refactor regresses the binding.
      if (this !== globalThis && this !== undefined) {
        return Promise.reject(
          new TypeError(
            `Illegal invocation: receiver was ${Object.prototype.toString.call(this)}`,
          ),
        );
      }
      void input;
      void init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            model: "test-model",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: checker,
    });
    try {
      const provider = new OpenAICompatProvider({
        base_url: "https://example.com/v1",
        api_key: "sk-test",
        default_model: "test-model",
        retry_policy: { max_retries: 0 },
      });
      const result = await provider.chat({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.content).toBe("ok");
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });
});
