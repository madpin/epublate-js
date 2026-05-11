/**
 * Provider-neutral LLM interface (mirrors `epublate.llm.base`).
 *
 * Every concrete provider — `openai_compat`, `mock` — implements
 * `LLMProvider`. Higher layers (pipeline, extractor, batch runner)
 * never import a concrete provider directly; they receive one through
 * the factory in `@/llm/factory` so the same code paths work against
 * the deterministic mock in tests.
 */

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

/** Subset of the OpenAI `response_format` shape we actually use. */
export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name: string; schema: unknown } };

export interface ChatRequest {
  messages: Message[];
  model: string;
  response_format?: ResponseFormat;
  temperature?: number;
  seed?: number;
  /**
   * OpenAI-style reasoning knob plus the Ollama-compat `"none"`
   * extension that disables thinking on thinking-capable models
   * (Qwen 3, DeepSeek-R1, Gemma 3 thinking, GPT-OSS reasoning).
   * Permissive endpoints silently ignore unknown values.
   */
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | "none";
  /** Request-cancellation hook (forwarded to fetch / mock). */
  signal?: AbortSignal;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ChatResult {
  content: string;
  usage: ChatUsage | null;
  model: string;
  /** True if the result came from cache; provider implementations may set. */
  cache_hit: boolean;
  /** Raw response payload for the audit log. */
  raw: unknown;
  /**
   * Wall-clock duration of the call, including retries, in milliseconds.
   * `null` when the provider didn't measure (e.g. mock with no clock).
   */
  duration_ms?: number | null;
}

/**
 * Provider rate-limit hint, sampled from response headers on a
 * successful call. Used by `src/core/batch.ts` to attenuate the
 * worker pool when the upstream is approaching its quota.
 *
 * All fields are `null` when the provider didn't expose that header.
 * Concrete shapes:
 *
 * - OpenAI / Anthropic / Mistral emit `x-ratelimit-remaining-requests`
 *   and `x-ratelimit-remaining-tokens` as integers.
 * - `x-ratelimit-reset-requests` is an ISO duration or seconds —
 *   we normalize to "milliseconds until reset".
 * - `Retry-After` on 4xx/5xx is captured separately and surfaced via
 *   the typed `LLMRateLimitError` (not here).
 *
 * Future signals (Anthropic's `anthropic-ratelimit-input-tokens-*`,
 * Vertex's `quota-project-*`) can slot in without breaking the
 * struct shape — readers MUST cope with `null` everywhere.
 */
export interface RateLimitHint {
  /** Requests remaining in the current quota window. */
  remaining_requests: number | null;
  /** Input/output tokens remaining in the current quota window. */
  remaining_tokens: number | null;
  /** Milliseconds until the request window resets, or null. */
  reset_requests_ms: number | null;
  /** Milliseconds until the token window resets, or null. */
  reset_tokens_ms: number | null;
  /** `performance.now()` when this hint was sampled. */
  observed_at: number;
}

export interface LLMProvider {
  /** Provider-shape identifier surfaced in the audit table. */
  readonly name: string;

  chat(request: ChatRequest): Promise<ChatResult>;

  /**
   * Most recent rate-limit hint observed by this provider, if any.
   * Optional: providers without rate-limit headers (mock, raw local
   * endpoints) need not implement. Returns `null` when nothing has
   * been observed yet.
   */
  getRateLimitHint?(): RateLimitHint | null;
}

/** Errors the pipeline knows how to react to. */
export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}

export class LLMResponseError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "LLMResponseError";
  }
}

export class LLMRateLimitError extends LLMError {
  /** Seconds until the endpoint says we can retry, when known. */
  retry_after_seconds: number | null;
  /** Verbatim message body so the curator sees the reason. */
  reason: string;
  constructor(
    message: string,
    options: { retry_after_seconds?: number | null; reason?: string } = {},
  ) {
    super(message);
    this.name = "LLMRateLimitError";
    this.retry_after_seconds = options.retry_after_seconds ?? null;
    this.reason = options.reason ?? message;
  }
}

export class LLMHttpError extends LLMError {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "LLMHttpError";
    this.status = status;
  }
}

export class LLMConfigurationError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "LLMConfigurationError";
  }
}
