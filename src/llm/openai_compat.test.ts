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

  it("forwards sanitized ollama options as a top-level `options` body field", async () => {
    let captured_body: string | undefined;
    const fetchImpl: typeof fetch = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        captured_body =
          typeof init?.body === "string" ? init.body : undefined;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            model: "llama3.2",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    const provider = new OpenAICompatProvider({
      base_url: "http://localhost:11434/v1",
      default_model: "llama3.2",
      retry_policy: { max_retries: 0 },
      fetchImpl,
      ollama_options: {
        num_ctx: 8192,
        // Out-of-range temperature must be clamped, not forwarded
        // verbatim — keeps the wire payload Ollama-acceptable even
        // when the curator pasted a typo into Settings.
        temperature: 99,
      },
    });
    await provider.chat({
      model: "llama3.2",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(captured_body).toBeDefined();
    const parsed = JSON.parse(captured_body!) as {
      options?: { num_ctx?: number; temperature?: number };
    };
    expect(parsed.options).toEqual({ num_ctx: 8192, temperature: 2 });
  });

  it("forwards ollama `think: false` as a top-level body field, not under `options`", async () => {
    let captured_body: string | undefined;
    const fetchImpl: typeof fetch = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        captured_body =
          typeof init?.body === "string" ? init.body : undefined;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            model: "qwen3",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    const provider = new OpenAICompatProvider({
      base_url: "http://localhost:11434/v1",
      default_model: "qwen3",
      retry_policy: { max_retries: 0 },
      fetchImpl,
      ollama_options: {
        num_ctx: 8192,
        think: false,
      },
    });
    await provider.chat({
      model: "qwen3",
      messages: [{ role: "user", content: "hi" }],
    });
    const parsed = JSON.parse(captured_body!) as {
      options?: Record<string, unknown>;
      think?: boolean;
    };
    expect(parsed.options).toEqual({ num_ctx: 8192 });
    expect(parsed.think).toBe(false);
    expect(parsed.options).not.toHaveProperty("think");
  });

  it("forwards `reasoning_effort: \"none\"` (Ollama-compat extension)", async () => {
    let captured_body: string | undefined;
    const fetchImpl: typeof fetch = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        captured_body =
          typeof init?.body === "string" ? init.body : undefined;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            model: "qwen3",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    const provider = new OpenAICompatProvider({
      base_url: "http://localhost:11434/v1",
      default_model: "qwen3",
      retry_policy: { max_retries: 0 },
      fetchImpl,
      reasoning_effort: "none",
    });
    await provider.chat({
      model: "qwen3",
      messages: [{ role: "user", content: "hi" }],
    });
    const parsed = JSON.parse(captured_body!) as {
      reasoning_effort?: string;
    };
    expect(parsed.reasoning_effort).toBe("none");
  });

  it("surfaces a curator-friendly message when a request times out", async () => {
    // Race the timeout against a fetch that never resolves so the
    // provider's internal AbortController fires. We use a short
    // timeout to keep the test fast.
    const fetchImpl: typeof fetch = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const provider = new OpenAICompatProvider({
      base_url: "http://localhost:11434/v1",
      default_model: "qwen3",
      timeout_ms: 30,
      retry_policy: {
        max_retries: 0,
        initial: 0,
        maximum: 0,
        multiplier: 2,
        jitter: false,
      },
      fetchImpl,
    });
    await expect(
      provider.chat({
        model: "qwen3",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/timed out after/i),
    });
  });

  it("omits the `options` field entirely when ollama_options is null", async () => {
    let captured_body: string | undefined;
    const fetchImpl: typeof fetch = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        captured_body =
          typeof init?.body === "string" ? init.body : undefined;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            model: "gpt-4o-mini",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    const provider = new OpenAICompatProvider({
      base_url: "https://api.openai.com/v1",
      default_model: "gpt-4o-mini",
      retry_policy: { max_retries: 0 },
      fetchImpl,
    });
    await provider.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(captured_body).toBeDefined();
    const parsed = JSON.parse(captured_body!) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("options");
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
