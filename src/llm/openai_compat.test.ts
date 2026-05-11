import { describe, expect, it, vi } from "vitest";

import { LLMError } from "@/llm/base";
import {
  explainFetchFailure,
  OpenAICompatProvider,
  parseRateLimitDuration,
  parseRateLimitHeaders,
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

  it("calls out Local Network Access when an HTTPS page targets http://localhost", () => {
    // Force the diagnostic into "page is HTTPS" mode without pulling
    // in JSDOM's full origin tracking.
    const original = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      value: {
        location: { origin: "https://epublate.example.app" },
      },
      configurable: true,
    });
    try {
      const err = new TypeError("Failed to fetch");
      const hint = explainFetchFailure(
        err,
        "http://localhost:11434/v1/chat/completions",
      );
      // Chrome 142+ uses LNA (the spec name); we surface that
      // explicitly so curators can search for it.
      expect(hint).toMatch(/Local Network Access|LNA/);
      // Tells the curator the legacy PNA flag is a no-op now.
      expect(hint).toContain("BlockInsecurePrivateNetworkRequests");
      expect(hint).toContain("https://epublate.example.app");
      expect(hint).toContain("tailscale serve");
      expect(hint).toContain("targetAddressSpace");
      // Both gates need to be cleared: LNA permission AND Ollama's
      // CORS allow-list. Surface the multi-scheme recipe so the
      // curator doesn't fall into the bare-`*` trap.
      expect(hint).toContain("OLLAMA_ORIGINS");
      expect(hint).toContain("https://*");
      // Should keep the practical curl probe intact.
      expect(hint).toContain("/v1/models");
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "window", {
          value: original,
          configurable: true,
        });
      } else {
        // @ts-expect-error – we delete the temporary stub when the
        // suite ran without a real window to begin with.
        delete globalThis.window;
      }
    }
  });

  it("offers an Ollama-specific hint when the page is loopback-on-loopback", () => {
    const original = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      value: { location: { origin: "http://localhost:5173" } },
      configurable: true,
    });
    try {
      const err = new TypeError("Failed to fetch");
      const hint = explainFetchFailure(
        err,
        "http://localhost:11434/v1/chat/completions",
      );
      expect(hint).toContain("OLLAMA_ORIGINS");
      // The bare `*` is too ambiguous; insist on the multi-scheme
      // allow-list. https:// in the value confirms the recipe will
      // unblock Vercel deploys, not just localhost-on-localhost.
      expect(hint).toContain("https://*");
      expect(hint).toContain("chrome-extension://*");
      expect(hint).toContain("launchctl");
      expect(hint).toContain("Access-Control-Allow-Origin");
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "window", {
          value: original,
          configurable: true,
        });
      } else {
        // @ts-expect-error – temporary stub cleanup.
        delete globalThis.window;
      }
    }
  });

  it("annotates loopback fetches with targetAddressSpace=loopback", async () => {
    let captured_init: RequestInit | undefined;
    const fetchImpl: typeof fetch = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        captured_init = init;
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
    });
    await provider.chat({
      model: "llama3.2",
      messages: [{ role: "user", content: "hi" }],
    });
    // Cast through `unknown`: `targetAddressSpace` is Chrome-specific
    // and not in the standard RequestInit typings.
    const lna = (captured_init as unknown as { targetAddressSpace?: string })
      .targetAddressSpace;
    expect(lna).toBe("loopback");
  });

  it("does not annotate cloud fetches with targetAddressSpace", async () => {
    let captured_init: RequestInit | undefined;
    const fetchImpl: typeof fetch = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        captured_init = init;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            model: "gpt-5-mini",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    const provider = new OpenAICompatProvider({
      base_url: "https://api.openai.com/v1",
      api_key: "sk-test",
      default_model: "gpt-5-mini",
      retry_policy: { max_retries: 0 },
      fetchImpl,
    });
    await provider.chat({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    const lna = (captured_init as unknown as { targetAddressSpace?: string })
      .targetAddressSpace;
    expect(lna).toBeUndefined();
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

describe("parseRateLimitDuration", () => {
  it("returns null for empty / missing values", () => {
    expect(parseRateLimitDuration(null)).toBeNull();
    expect(parseRateLimitDuration("")).toBeNull();
    expect(parseRateLimitDuration("   ")).toBeNull();
  });

  it("treats a bare number as seconds", () => {
    expect(parseRateLimitDuration("60")).toBe(60_000);
    expect(parseRateLimitDuration("0")).toBe(0);
    expect(parseRateLimitDuration("0.5")).toBe(500);
  });

  it("parses 's' / 'm' / 'h' suffixes", () => {
    expect(parseRateLimitDuration("60s")).toBe(60_000);
    expect(parseRateLimitDuration("1.5s")).toBe(1500);
    expect(parseRateLimitDuration("6m0s")).toBe(360_000);
    expect(parseRateLimitDuration("2h30m")).toBe(2 * 3_600_000 + 30 * 60_000);
  });

  it("parses 'ms' before 'm|s' in alternation", () => {
    expect(parseRateLimitDuration("250ms")).toBe(250);
    expect(parseRateLimitDuration("1s250ms")).toBe(1250);
  });

  it("returns null for garbage", () => {
    expect(parseRateLimitDuration("nope")).toBeNull();
    expect(parseRateLimitDuration("--")).toBeNull();
  });
});

describe("parseRateLimitHeaders", () => {
  it("returns null when no x-ratelimit-* headers are present", () => {
    expect(parseRateLimitHeaders(new Headers())).toBeNull();
    expect(
      parseRateLimitHeaders(new Headers({ "content-type": "text/plain" })),
    ).toBeNull();
  });

  it("samples remaining-requests / remaining-tokens as integers", () => {
    const hint = parseRateLimitHeaders(
      new Headers({
        "x-ratelimit-remaining-requests": "42",
        "x-ratelimit-remaining-tokens": "1000",
      }),
    );
    expect(hint).not.toBeNull();
    expect(hint!.remaining_requests).toBe(42);
    expect(hint!.remaining_tokens).toBe(1000);
    expect(hint!.reset_requests_ms).toBeNull();
    expect(hint!.reset_tokens_ms).toBeNull();
    expect(typeof hint!.observed_at).toBe("number");
  });

  it("converts x-ratelimit-reset-* to milliseconds", () => {
    const hint = parseRateLimitHeaders(
      new Headers({
        "x-ratelimit-reset-requests": "6m0s",
        "x-ratelimit-reset-tokens": "1.5s",
      }),
    );
    expect(hint).not.toBeNull();
    expect(hint!.reset_requests_ms).toBe(360_000);
    expect(hint!.reset_tokens_ms).toBe(1500);
  });

  it("partial headers → partial hint, missing fields are null", () => {
    const hint = parseRateLimitHeaders(
      new Headers({ "x-ratelimit-remaining-requests": "5" }),
    );
    expect(hint).not.toBeNull();
    expect(hint!.remaining_requests).toBe(5);
    expect(hint!.remaining_tokens).toBeNull();
    expect(hint!.reset_requests_ms).toBeNull();
    expect(hint!.reset_tokens_ms).toBeNull();
  });
});

describe("OpenAICompatProvider.getRateLimitHint", () => {
  it("captures the most recent x-ratelimit-* response headers", async () => {
    let callIdx = 0;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      callIdx += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          model: "test-model",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining-requests": String(100 - callIdx),
            "x-ratelimit-remaining-tokens": String(10000 - callIdx * 10),
            "x-ratelimit-reset-requests": "60s",
            "x-ratelimit-reset-tokens": "30s",
          },
        },
      );
    });
    const provider = new OpenAICompatProvider({
      base_url: "https://example.com/v1",
      api_key: "sk-test",
      default_model: "test-model",
      retry_policy: { max_retries: 0 },
      fetchImpl,
    });
    expect(provider.getRateLimitHint()).toBeNull();
    await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
    });
    const first = provider.getRateLimitHint();
    expect(first).not.toBeNull();
    expect(first!.remaining_requests).toBe(99);
    expect(first!.reset_requests_ms).toBe(60_000);
    await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "again" }],
    });
    const second = provider.getRateLimitHint();
    expect(second).not.toBeNull();
    expect(second!.remaining_requests).toBe(98);
  });

  it("leaves the cached hint untouched when the provider omits headers", async () => {
    const fetchImpl: typeof fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            model: "test-model",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-remaining-requests": "10",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "again" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            model: "test-model",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }, // no rate-limit headers
          },
        ),
      );
    const provider = new OpenAICompatProvider({
      base_url: "https://example.com/v1",
      api_key: "sk-test",
      default_model: "test-model",
      retry_policy: { max_retries: 0 },
      fetchImpl,
    });
    await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "1" }],
    });
    expect(provider.getRateLimitHint()!.remaining_requests).toBe(10);
    await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "2" }],
    });
    // Sticky: a header-less response doesn't clear a previously good hint.
    expect(provider.getRateLimitHint()!.remaining_requests).toBe(10);
  });
});
