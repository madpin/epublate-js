/**
 * Soft-fallback wrapper for chat calls that request JSON mode
 * (mirrors `epublate.llm.json_mode`).
 *
 * Some OpenAI-compatible endpoints reject `response_format=json_object`
 * in narrow conditions:
 *
 * - Groq (proxied via LiteLLM) runs a grammar validator AFTER
 *   generation and returns 400 with `json_validate_failed` when the
 *   visible content is empty — typical for reasoning helpers that
 *   spend their visible-channel budget on reasoning tokens.
 * - Older self-hosted llama.cpp / Ollama builds return a 400 with
 *   `response_format` mentioned somewhere in the body.
 * - Some Ollama builds (notably the `gemma4:*` family at the time of
 *   writing) crash the underlying llama.cpp runner when JSON-mode
 *   grammar-constrained sampling is enabled, surfacing as a 5xx
 *   `"llama runner process no longer running"` error. The runner is
 *   re-spawned for the next request, so retrying without
 *   `response_format` succeeds.
 *
 * Hard-failing breaks the helper-LLM extractor on those endpoints. We
 * retry the call once *without* `response_format` so the prompt's
 * "respond with JSON only" instruction is the last constraint left.
 */

import {
  type ChatRequest,
  type ChatResult,
  type LLMProvider,
  LLMHttpError,
  LLMRateLimitError,
  LLMResponseError,
} from "./base";

const JSON_MODE_ERROR_PATTERNS: readonly string[] = [
  "json_validate_failed",
  "response_format",
  "json mode",
  "structured output",
  "response format",
  // Ollama runner crash from json-grammar sampling on some model
  // families (e.g. `gemma4:26b`). The runner is re-spawned before the
  // next request, so dropping `response_format` lets us recover.
  "llama runner process",
];

export async function chatWithJsonFallback(
  provider: LLMProvider,
  request: ChatRequest,
): Promise<ChatResult> {
  try {
    return await provider.chat(request);
  } catch (err: unknown) {
    if (err instanceof LLMRateLimitError) throw err;
    if (
      (err instanceof LLMResponseError || err instanceof LLMHttpError) &&
      request.response_format != null &&
      isJsonModeError(err)
    ) {
      const next = { ...request };
      delete next.response_format;
      return provider.chat(next);
    }
    throw err;
  }
}

function isJsonModeError(err: Error): boolean {
  const text = (err.message ?? "").toLowerCase();
  return JSON_MODE_ERROR_PATTERNS.some((p) => text.includes(p));
}
