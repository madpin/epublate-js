import { describe, expect, it, vi } from "vitest";

import {
  EmbeddingError,
  EmbeddingHttpError,
  EmbeddingRateLimitError,
} from "@/llm/embeddings/base";
import { OpenAICompatEmbeddingProvider } from "@/llm/embeddings/openai_compat";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("OpenAICompatEmbeddingProvider", () => {
  it("posts to /embeddings and returns Float32Array vectors in input order", async () => {
    let captured_url: string | undefined;
    let captured_body: unknown;
    const fetchImpl: typeof fetch = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        captured_url = typeof input === "string" ? input : String(input);
        captured_body = init?.body
          ? JSON.parse(init.body as string)
          : undefined;
        return jsonResponse({
          object: "list",
          model: "text-embedding-3-small",
          data: [
            { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },
            { object: "embedding", index: 1, embedding: [0.4, 0.5, 0.6] },
          ],
          usage: { prompt_tokens: 7, total_tokens: 7 },
        });
      },
    );
    const provider = new OpenAICompatEmbeddingProvider({
      base_url: "https://api.example.com/v1",
      api_key: "sk-abc",
      model: "text-embedding-3-small",
      dim: 3,
      retry_policy: { max_retries: 0 },
      fetchImpl,
    });
    const result = await provider.embed(["alpha", "beta"]);
    expect(captured_url).toBe("https://api.example.com/v1/embeddings");
    expect(captured_body).toMatchObject({
      model: "text-embedding-3-small",
      input: ["alpha", "beta"],
    });
    // Voyage AI (and other providers behind LiteLLM) reject
    // `encoding_format: "float"` with `Value 'float' supplied`. The
    // OpenAI default already returns float arrays when the field is
    // omitted, so we make sure we never send it.
    expect(captured_body as Record<string, unknown>).not.toHaveProperty(
      "encoding_format",
    );
    expect(result.vectors).toHaveLength(2);
    expect(Array.from(result.vectors[0]!)).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
    expect(Array.from(result.vectors[1]!)).toEqual([
      Math.fround(0.4),
      Math.fround(0.5),
      Math.fround(0.6),
    ]);
    expect(result.model).toBe("text-embedding-3-small");
    expect(result.usage?.prompt_tokens).toBe(7);
  });

  it("preserves input order when the server returns rows out of order", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        jsonResponse({
          data: [
            { index: 1, embedding: [9, 9, 9] },
            { index: 0, embedding: [1, 1, 1] },
          ],
          usage: { prompt_tokens: 4 },
        }),
    );
    const provider = new OpenAICompatEmbeddingProvider({
      base_url: "https://api.example.com/v1",
      model: "m",
      dim: 3,
      retry_policy: { max_retries: 0 },
      fetchImpl,
    });
    const result = await provider.embed(["a", "b"]);
    expect(Array.from(result.vectors[0]!)).toEqual([1, 1, 1]);
    expect(Array.from(result.vectors[1]!)).toEqual([9, 9, 9]);
  });

  it("batches large inputs and aggregates usage across calls", async () => {
    const fetchImpl = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string) as { input: string[] };
        return jsonResponse({
          data: body.input.map((_, i) => ({
            index: i,
            embedding: [i + 0.1, i + 0.2, i + 0.3],
          })),
          usage: { prompt_tokens: body.input.length },
        });
      },
    );
    const provider = new OpenAICompatEmbeddingProvider({
      base_url: "https://api.example.com/v1",
      model: "m",
      dim: 3,
      batch_size: 2,
      retry_policy: { max_retries: 0 },
      fetchImpl,
    });
    const inputs = ["a", "b", "c", "d", "e"];
    const result = await provider.embed(inputs);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 2 + 2 + 1
    expect(result.vectors).toHaveLength(5);
    expect(result.usage?.prompt_tokens).toBe(5);
  });

  it("rejects payloads whose dim doesn't match the configured dim", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        jsonResponse({
          data: [{ index: 0, embedding: [1, 2, 3] }],
        }),
    );
    const provider = new OpenAICompatEmbeddingProvider({
      base_url: "https://api.example.com/v1",
      model: "m",
      dim: 16, // mismatch
      retry_policy: { max_retries: 0 },
      fetchImpl,
    });
    await expect(provider.embed(["a"])).rejects.toThrow(/dim/);
  });

  it("accepts dim mismatch when validate_dim is false (test-button mode)", async () => {
    // The Settings → Embeddings test button passes `validate_dim:
    // false` so a curator probing voyage-3.5 (1024-dim) doesn't
    // bounce off the guard rail set up for text-embedding-3-small
    // (1536-dim). The probe must still return the vectors so the UI
    // can auto-suggest the correct dim.
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        jsonResponse({
          data: [
            {
              index: 0,
              embedding: Array.from({ length: 1024 }, (_, i) => i / 1024),
            },
          ],
          model: "voyage-3.5",
        }),
    );
    const provider = new OpenAICompatEmbeddingProvider({
      base_url: "https://api.example.com/v1",
      model: "voyage-3.5",
      dim: 1536, // mismatch
      validate_dim: false,
      retry_policy: { max_retries: 0 },
      fetchImpl,
    });
    const result = await provider.embed(["a"]);
    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0]!.length).toBe(1024);
  });

  it("retries 429 and surfaces rate-limit error after exhausting attempts", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "1" },
        }),
    );
    const provider = new OpenAICompatEmbeddingProvider({
      base_url: "https://api.example.com/v1",
      model: "m",
      dim: 3,
      retry_policy: {
        max_retries: 1,
        initial: 0.001,
        maximum: 0.001,
        multiplier: 1,
        jitter: false,
      },
      fetchImpl,
      sleepImpl: async () => {
        /* no real wait in tests */
      },
    });
    await expect(provider.embed(["a"])).rejects.toBeInstanceOf(
      EmbeddingRateLimitError,
    );
    // initial attempt + 1 retry = 2 calls
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces a non-retryable HTTP error without retrying", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        new Response("bad request", {
          status: 400,
        }),
    );
    const provider = new OpenAICompatEmbeddingProvider({
      base_url: "https://api.example.com/v1",
      model: "m",
      dim: 3,
      retry_policy: { max_retries: 4 },
      fetchImpl,
    });
    await expect(provider.embed(["a"])).rejects.toBeInstanceOf(
      EmbeddingHttpError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects construction without a model or dim", () => {
    expect(
      () =>
        new OpenAICompatEmbeddingProvider({
          base_url: "https://api.example.com/v1",
          model: "",
          dim: 3,
        }),
    ).toThrow(EmbeddingError);
    expect(
      () =>
        new OpenAICompatEmbeddingProvider({
          base_url: "https://api.example.com/v1",
          model: "m",
          dim: 0,
        }),
    ).toThrow(EmbeddingError);
  });

  it("trims surrounding whitespace + newlines from the api key", async () => {
    let captured_headers: Record<string, string> | undefined;
    const fetchImpl: typeof fetch = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        captured_headers = init?.headers as Record<string, string>;
        return jsonResponse({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
          usage: { prompt_tokens: 1 },
        });
      },
    );
    const provider = new OpenAICompatEmbeddingProvider({
      base_url: "  https://api.example.com/v1/  ",
      api_key: "sk-trailing-newline\n",
      model: "m",
      dim: 3,
      retry_policy: { max_retries: 0 },
      fetchImpl,
    });
    await provider.embed(["a"]);
    expect(captured_headers!.Authorization).toBe(
      "Bearer sk-trailing-newline",
    );
  });

  it("surfaces the inner `error.message` from a litellm-style 500 body", async () => {
    const body = {
      error: {
        message:
          "litellm.APIConnectionError: VoyageException - {\"detail\":\"The request body is not valid JSON, or some arguments were not specified properly. In particular, Value 'float' supplied for encoding_format is not allowed\"}",
      },
    };
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    const provider = new OpenAICompatEmbeddingProvider({
      base_url: "https://api.example.com/v1",
      model: "m",
      dim: 3,
      retry_policy: { max_retries: 0 },
      fetchImpl,
    });
    let caught: unknown = null;
    try {
      await provider.embed(["a"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmbeddingHttpError);
    expect((caught as Error).message).toContain("500");
    expect((caught as Error).message).toContain("VoyageException");
    expect((caught as Error).message).toContain("Value 'float'");
    expect((caught as Error).message).not.toContain("error\":{");
  });

  it("surfaces the quota message from a litellm-style 429 body", async () => {
    const body = {
      error: {
        message:
          "litellm.RateLimitError: RateLimitError: OpenAIException - Error code: 429 - {'error': {'message': 'You exceeded your current quota, please check your plan and billing details.', 'type': 'insufficient_quota', 'code': 'insufficient_quota'}}",
      },
    };
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );
    const provider = new OpenAICompatEmbeddingProvider({
      base_url: "https://api.example.com/v1",
      model: "m",
      dim: 3,
      retry_policy: {
        max_retries: 0,
        initial: 0.001,
        maximum: 0.001,
        multiplier: 1,
        jitter: false,
      },
      fetchImpl,
      sleepImpl: async () => {
        /* no real wait in tests */
      },
    });
    let caught: unknown = null;
    try {
      await provider.embed(["a"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmbeddingRateLimitError);
    expect((caught as Error).message).toContain("rate limit");
    expect((caught as Error).message).toContain(
      "exceeded your current quota",
    );
  });

  it("returns an empty result for an empty input list (no fetch)", async () => {
    const fetchImpl = vi.fn();
    const provider = new OpenAICompatEmbeddingProvider({
      base_url: "https://api.example.com/v1",
      model: "m",
      dim: 3,
      retry_policy: { max_retries: 0 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.embed([]);
    expect(result.vectors).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
