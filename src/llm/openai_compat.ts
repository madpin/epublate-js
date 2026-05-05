/**
 * Browser-side OpenAI-compatible provider (mirrors
 * `epublate.llm.openai_compat`).
 *
 * Targets the `/v1/chat/completions` shape and works against any
 * provider that speaks it: OpenAI, Azure OpenAI, OpenRouter, Together,
 * Ollama (with `OLLAMA_ORIGINS=*`), vLLM, llama.cpp.
 *
 * Implementation notes (browser-specific):
 *
 * - We own the retry loop with full-jitter exponential backoff so we
 *   can apply the same Retry-After / X-RateLimit-Reset parsing the
 *   Python tool uses, and surface failures via the typed `LLMError`
 *   hierarchy from `@/llm/base`.
 * - CORS is the curator's responsibility; a CORS rejection surfaces
 *   here as an `LLMError("network error")` because the browser never
 *   exposes the underlying status to JS. A best-effort hint is added
 *   so the Settings screen can guide them to the docs.
 * - API keys never enter the request payload echoed back to callers;
 *   we construct that echo from our own `Message` array, not from the
 *   wire payload.
 */

import {
  type ChatRequest,
  type ChatResult,
  type LLMProvider,
  type Message,
  type ResponseFormat,
  LLMError,
  LLMHttpError,
  LLMRateLimitError,
  LLMResponseError,
} from "./base";

const DEFAULT_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 409, 500, 502, 503, 504,
]);

/**
 * Honor the provider's Retry-After hint up to this cap. Above it we
 * lift out the rate-limit error so the orchestrator can pause cleanly
 * instead of sleeping a worker for hours (depleted daily / monthly
 * quotas — OpenRouter free tier resets at UTC midnight).
 */
const RATE_LIMIT_SHORT_WAIT_CAP_SECONDS = 120.0;

const VALID_REASONING_EFFORTS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
] as const);

export interface RetryPolicy {
  max_retries: number;
  initial: number;
  maximum: number;
  multiplier: number;
  jitter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  max_retries: 4,
  initial: 0.5,
  maximum: 8.0,
  multiplier: 2.0,
  jitter: true,
};

function delayFor(policy: RetryPolicy, attempt: number): number {
  if (attempt <= 0) return 0;
  const base = Math.min(
    policy.maximum,
    policy.initial * Math.pow(policy.multiplier, attempt - 1),
  );
  if (!policy.jitter) return base;
  return Math.random() * base;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface OpenAICompatProviderOptions {
  base_url: string;
  api_key?: string;
  default_model?: string;
  organization?: string;
  /** Total request timeout in milliseconds; default 60s. */
  timeout_ms?: number;
  retry_policy?: Partial<RetryPolicy>;
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | null;
  /**
   * Optional `fetch` override. Tests inject a mocked fetch; the
   * production code uses the global.
   */
  fetchImpl?: typeof fetch;
  /** Test seam — replaces `setTimeout`-based sleep. */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * OpenAI-compatible chat-completions provider.
 *
 * Stateless w.r.t. requests; safe to keep one instance across calls.
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name = "openai_compat";

  private readonly base_url: string;
  private readonly api_key: string;
  private readonly default_model: string | null;
  private readonly organization: string | null;
  private readonly timeout_ms: number;
  private readonly retry: RetryPolicy;
  private readonly reasoning_effort:
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: OpenAICompatProviderOptions) {
    if (!options.base_url || !options.base_url.trim()) {
      throw new LLMError("OpenAICompatProvider requires base_url");
    }
    // Aggressively trim to absorb common copy-paste artefacts (a
    // trailing `\n` in the API key produces `Authorization: Bearer
    // sk-…\n`, which Chromium/Firefox reject synchronously with
    // `TypeError: Failed to execute 'fetch' on 'Window'` before any
    // network round-trip — the most common false-positive "network
    // error" curators report).
    this.base_url = options.base_url.trim().replace(/\/+$/, "");
    this.api_key = (options.api_key ?? "").trim();
    this.default_model = options.default_model?.trim() || null;
    this.organization = options.organization?.trim() || null;
    if (this.api_key && !isHeaderValueSafe(this.api_key)) {
      throw new LLMError(
        "API key contains characters that are not allowed in HTTP headers " +
          "(newline, tab, or non-ASCII). Re-paste the key without any " +
          "surrounding whitespace.",
      );
    }
    if (this.organization && !isHeaderValueSafe(this.organization)) {
      throw new LLMError(
        "Organization id contains characters that are not allowed in " +
          "HTTP headers. Strip whitespace and non-ASCII characters.",
      );
    }
    this.timeout_ms = options.timeout_ms ?? 60_000;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...(options.retry_policy ?? {}) };
    if (
      options.reasoning_effort != null &&
      !VALID_REASONING_EFFORTS.has(options.reasoning_effort)
    ) {
      throw new LLMResponseError(
        `reasoning_effort must be one of ${[...VALID_REASONING_EFFORTS].join("|")}; got ${options.reasoning_effort}`,
      );
    }
    this.reasoning_effort = options.reasoning_effort ?? null;
    // The native browser `fetch` is a "method on window" — it throws
    // `TypeError: Illegal invocation` if invoked with any other `this`
    // binding. Assigning `globalThis.fetch` to a class field changes
    // `this` to the class instance, so we must bind it back. Tests
    // pass a `fetchImpl` directly, which is why this only ever
    // surfaced in the real browser.
    this.fetchImpl = options.fetchImpl
      ? options.fetchImpl
      : (globalThis.fetch as typeof fetch).bind(globalThis);
    this.sleepImpl = options.sleepImpl ?? sleep;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    if (!request.messages.length) {
      throw new LLMResponseError("messages must not be empty");
    }
    const model = request.model || this.default_model;
    if (!model) {
      throw new LLMResponseError(
        "no model: pass `model` on the request or set default_model",
      );
    }

    const body = this.buildPayload({ ...request, model });
    const url = `${this.base_url}/chat/completions`;
    const attempts = this.retry.max_retries + 1;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const delay = delayFor(this.retry, attempt);
      if (delay > 0) await this.sleepImpl(delay * 1000, request.signal);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeout_ms);
      // Cancel both ways: outer signal + our timeout.
      const onOuterAbort = (): void => controller.abort();
      request.signal?.addEventListener("abort", onOuterAbort, { once: true });

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err: unknown) {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onOuterAbort);
        if (
          err instanceof DOMException &&
          err.name === "AbortError" &&
          request.signal?.aborted
        ) {
          throw err;
        }
        lastErr = err;
        if (attempt < attempts - 1) {
          continue;
        }
        throw new LLMError(
          `network error talking to ${url}: ${explainFetchFailure(err, url)}`,
        );
      }

      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onOuterAbort);

      if (response.ok) {
        const json = (await response.json()) as ChatCompletionPayload;
        return parseCompletion(json, model, request.messages);
      }

      const text = await readBody(response);
      if (response.status === 429) {
        const retry_after = parseRetryAfter(response.headers);
        if (
          retry_after != null &&
          retry_after > RATE_LIMIT_SHORT_WAIT_CAP_SECONDS
        ) {
          throw new LLMRateLimitError(
            `OpenAI-compatible 429: ${truncate(text, 200)}`,
            { retry_after_seconds: retry_after, reason: text },
          );
        }
        if (attempt < attempts - 1) {
          if (retry_after != null && retry_after > 0) {
            await this.sleepImpl(retry_after * 1000, request.signal);
          }
          lastErr = new LLMRateLimitError(`429`, {
            retry_after_seconds: retry_after,
            reason: text,
          });
          continue;
        }
        throw new LLMRateLimitError(
          `OpenAI-compatible 429 after ${attempts} attempts: ${truncate(text, 200)}`,
          { retry_after_seconds: retry_after, reason: text },
        );
      }

      if (
        DEFAULT_RETRYABLE_STATUSES.has(response.status) &&
        attempt < attempts - 1
      ) {
        lastErr = new LLMHttpError(
          `${response.status}: ${truncate(text, 200)}`,
          response.status,
        );
        continue;
      }

      throw new LLMHttpError(
        `OpenAI-compatible status ${response.status}: ${truncate(text, 200)}`,
        response.status,
      );
    }

    if (lastErr instanceof LLMError) throw lastErr;
    throw new LLMError(
      `retry loop exited without a result (last error: ${lastErr})`,
    );
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.api_key) h.Authorization = `Bearer ${this.api_key}`;
    if (this.organization) h["OpenAI-Organization"] = this.organization;
    return h;
  }

  private buildPayload(request: ChatRequest & { model: string }): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m: Message) => ({
        role: m.role,
        content: m.content,
      })),
    };
    if (request.temperature != null) payload.temperature = request.temperature;
    if (request.seed != null) payload.seed = request.seed;
    const rf = request.response_format;
    if (rf) payload.response_format = serializeResponseFormat(rf);
    const re = request.reasoning_effort ?? this.reasoning_effort;
    if (re) payload.reasoning_effort = re;
    return payload;
  }
}

interface ChatCompletionPayload {
  id?: string;
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
  } | null;
  [k: string]: unknown;
}

function serializeResponseFormat(rf: ResponseFormat): Record<string, unknown> {
  if (rf.type === "json_object") return { type: "json_object" };
  if (rf.type === "text") return { type: "text" };
  if (rf.type === "json_schema") {
    return { type: "json_schema", json_schema: rf.json_schema };
  }
  throw new LLMResponseError(
    `unknown response_format type: ${(rf as { type: string }).type}`,
  );
}

function parseCompletion(
  payload: ChatCompletionPayload,
  fallback_model: string,
  sent: Message[],
): ChatResult {
  const choice = payload.choices?.[0];
  const content = choice?.message?.content ?? "";
  if (!choice) {
    throw new LLMResponseError("chat-completion returned no choices");
  }
  const usage = payload.usage ?? null;
  let prompt_tokens = 0;
  let completion_tokens = 0;
  if (usage) {
    prompt_tokens = Math.max(0, Number(usage.prompt_tokens ?? 0) | 0);
    completion_tokens = Math.max(0, Number(usage.completion_tokens ?? 0) | 0);
  } else {
    // Heuristic only when the endpoint omits `usage`. The pipeline can
    // still record cost, just imprecisely.
    prompt_tokens = sent.reduce(
      (a, m) => a + Math.max(1, Math.floor(m.content.length / 4)),
      0,
    );
    completion_tokens = Math.max(1, Math.floor(content.length / 4));
  }
  return {
    content,
    usage: { prompt_tokens, completion_tokens },
    model: payload.model || fallback_model,
    cache_hit: false,
    raw: payload,
  };
}

function parseRetryAfter(headers: Headers): number | null {
  const retry_after = headers.get("Retry-After");
  if (retry_after) {
    const n = Number(retry_after);
    if (Number.isFinite(n)) return Math.max(0, n);
    const date = Date.parse(retry_after);
    if (!Number.isNaN(date)) {
      return Math.max(0, (date - Date.now()) / 1000);
    }
  }
  const reset = headers.get("X-RateLimit-Reset");
  if (reset) {
    const ms = Number(reset);
    if (Number.isFinite(ms)) {
      const reset_epoch_s = ms / 1000;
      return Math.max(0, reset_epoch_s - Date.now() / 1000);
    }
  }
  return null;
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}\u2026`;
}

/**
 * Reject header values that contain characters the browser's `fetch`
 * will refuse synchronously: control chars (incl. `\n`, `\r`, `\t`)
 * and any non-ISO-8859-1 code point. We're stricter than the spec on
 * purpose — modern OpenAI-compatible API keys are pure ASCII, so the
 * only realistic source of these bytes is a copy-paste artefact.
 */
function isHeaderValueSafe(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code > 0xff) return false;
  }
  return true;
}

/**
 * Best-effort hint for the most common browser-side fetch failures.
 * We don't get a real error code from the browser when CORS rejects a
 * preflight, so the heuristic is text-based and intentionally cheap.
 */
export function explainFetchFailure(err: unknown, url: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Illegal invocation/i.test(msg)) {
    return (
      `${msg} (the global \`fetch\` was invoked without its window ` +
      `binding — this is an internal bug; please file an issue with ` +
      `the steps to reproduce).`
    );
  }
  if (/Failed to execute 'fetch'/i.test(msg)) {
    return (
      `${msg} (this usually means the request was rejected by the ` +
      `browser before the network call — most often a stray newline in ` +
      `the API key or organization id, or a non-ASCII character in a ` +
      `header). Re-paste your key in Settings → LLM and try again.`
    );
  }
  if (/Failed to fetch|Load failed|NetworkError/i.test(msg)) {
    let hostname = url;
    try {
      hostname = new URL(url).hostname;
    } catch {
      /* keep raw url */
    }
    return (
      `${msg} (the browser blocked the request to ${hostname} — usually ` +
      `a CORS rejection, an expired DNS record, or the endpoint being ` +
      `offline). For local Ollama, set OLLAMA_ORIGINS=*; for cloud ` +
      `endpoints, confirm the URL responds to a curl POST.`
    );
  }
  return msg;
}
