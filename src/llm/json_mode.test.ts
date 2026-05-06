/**
 * Unit tests for `chatWithJsonFallback`.
 *
 * We don't try to exhaustively replay the OpenAI/Ollama wire surface
 * here — `openai_compat.test.ts` does that. The job of this suite is
 * to lock in the fallback contract: which classes of upstream errors
 * cause us to retry once *without* `response_format`, and which ones
 * we let propagate.
 */

import { describe, expect, it, vi } from "vitest";

import {
  type ChatRequest,
  type ChatResult,
  type LLMProvider,
  LLMHttpError,
  LLMRateLimitError,
  LLMResponseError,
} from "./base";
import { chatWithJsonFallback } from "./json_mode";

const SUCCESS: ChatResult = {
  content: "{\"ok\": true}",
  usage: { prompt_tokens: 1, completion_tokens: 2 },
  model: "test",
  cache_hit: false,
  raw: {},
};

function makeProvider(
  responses: Array<ChatResult | Error>,
): { provider: LLMProvider; calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  let i = 0;
  const provider: LLMProvider = {
    name: "test",
    chat: vi.fn(async (req: ChatRequest) => {
      calls.push(req);
      const next = responses[i++];
      if (!next) throw new Error(`unexpected extra call (${i})`);
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  return { provider, calls };
}

const REQUEST: ChatRequest = {
  messages: [{ role: "user", content: "hi" }],
  model: "test-model",
  response_format: { type: "json_object" },
};

describe("chatWithJsonFallback", () => {
  it("forwards the result when the provider succeeds on the first try", async () => {
    const { provider, calls } = makeProvider([SUCCESS]);
    await expect(chatWithJsonFallback(provider, REQUEST)).resolves.toBe(SUCCESS);
    expect(calls).toHaveLength(1);
    expect(calls[0].response_format).toEqual({ type: "json_object" });
  });

  it("retries without response_format when the upstream complains about JSON mode", async () => {
    const { provider, calls } = makeProvider([
      new LLMHttpError(
        "Upstream returned 400 for url ... — body: { error: 'response_format not supported' }",
        400,
      ),
      SUCCESS,
    ]);
    await expect(chatWithJsonFallback(provider, REQUEST)).resolves.toBe(SUCCESS);
    expect(calls).toHaveLength(2);
    expect(calls[0].response_format).toEqual({ type: "json_object" });
    expect(calls[1]).not.toHaveProperty("response_format");
  });

  it("retries without response_format on a Groq json_validate_failed error", async () => {
    const { provider } = makeProvider([
      new LLMResponseError(
        "Groq grammar validator returned json_validate_failed",
      ),
      SUCCESS,
    ]);
    await expect(chatWithJsonFallback(provider, REQUEST)).resolves.toBe(SUCCESS);
  });

  it("retries when Ollama crashes its llama runner under JSON mode", async () => {
    // Real symptom from `gemma4:26b` + `response_format: json_object`:
    // the runner dies mid-request; Ollama returns 500 with this body.
    const { provider, calls } = makeProvider([
      new LLMHttpError(
        "Upstream 500: { error: { message: 'llama runner process no longer running: -1 ' } }",
        500,
      ),
      SUCCESS,
    ]);
    await expect(chatWithJsonFallback(provider, REQUEST)).resolves.toBe(SUCCESS);
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toHaveProperty("response_format");
  });

  it("does not retry when the request had no response_format to begin with", async () => {
    const { provider, calls } = makeProvider([
      new LLMHttpError("Upstream 500: response_format invalid", 500),
    ]);
    await expect(
      chatWithJsonFallback(provider, {
        messages: REQUEST.messages,
        model: REQUEST.model,
      }),
    ).rejects.toBeInstanceOf(LLMHttpError);
    expect(calls).toHaveLength(1);
  });

  it("does not retry on rate-limit errors — those are surfaced for the curator", async () => {
    const rate = new LLMRateLimitError("Too many requests", {
      retry_after_seconds: 30,
    });
    const { provider, calls } = makeProvider([rate]);
    await expect(chatWithJsonFallback(provider, REQUEST)).rejects.toBe(rate);
    expect(calls).toHaveLength(1);
  });

  it("does not retry on errors unrelated to JSON mode", async () => {
    const { provider, calls } = makeProvider([
      new LLMHttpError("Upstream 500: out of memory", 500),
    ]);
    await expect(chatWithJsonFallback(provider, REQUEST)).rejects.toBeInstanceOf(
      LLMHttpError,
    );
    expect(calls).toHaveLength(1);
  });
});
