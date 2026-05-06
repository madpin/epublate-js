/**
 * Browser-side OpenAI-compatible embedding provider (sibling to
 * `OpenAICompatProvider`).
 *
 * Targets the `/v1/embeddings` shape and works against any provider
 * that speaks it: OpenAI, Azure OpenAI, OpenRouter, Together, Ollama
 * (`OLLAMA_ORIGINS=*`), vLLM, llama.cpp, BAAI/bge-* on a self-hosted
 * inference server.
 *
 * Mirrors the retry / backoff / Retry-After parsing behavior in
 * `@/llm/openai_compat` so curators see the same failure semantics
 * across translator and embedding calls. Implements input batching
 * (default 64) so a 10k-segment intake makes ~150 round-trips instead
 * of 10k.
 */

import {
  type EmbeddingProvider,
  type EmbeddingResult,
  type EmbeddingUsage,
  EmbeddingError,
  EmbeddingHttpError,
  EmbeddingRateLimitError,
} from "./base";

const DEFAULT_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 409, 500, 502, 503, 504,
]);

/** Above this Retry-After value, surface the rate-limit error to the orchestrator. */
const RATE_LIMIT_SHORT_WAIT_CAP_SECONDS = 120.0;

/** OpenAI's documented per-request input cap (8 192 tokens) — chunk above. */
const DEFAULT_BATCH_SIZE = 64;

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

function nowMillis(): number {
  if (typeof performance !== "undefined" && performance.now) {
    return performance.now();
  }
  return Date.now();
}

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

export interface OpenAICompatEmbeddingProviderOptions {
  base_url: string;
  api_key?: string;
  model: string;
  organization?: string;
  /** Vector dimensionality — required because providers don't always echo it. */
  dim: number;
  /** Per-request batch size; defaults to 64. */
  batch_size?: number;
  timeout_ms?: number;
  retry_policy?: Partial<RetryPolicy>;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * If `false`, accept any dim returned by the server (instead of
   * throwing on a mismatch). The Settings → Embeddings test button
   * uses this so curators can probe an unfamiliar model and see the
   * actual dim instead of bouncing off a guard rail. Defaults to
   * `true` in production paths to keep IndexedDB writes consistent.
   */
  validate_dim?: boolean;
}

export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai_compat";
  readonly model: string;
  readonly dim: number;
  readonly batch_size: number;

  private readonly base_url: string;
  private readonly api_key: string;
  private readonly organization: string | null;
  private readonly timeout_ms: number;
  private readonly retry: RetryPolicy;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly validate_dim: boolean;

  constructor(options: OpenAICompatEmbeddingProviderOptions) {
    if (!options.base_url || !options.base_url.trim()) {
      throw new EmbeddingError(
        "OpenAICompatEmbeddingProvider requires base_url",
      );
    }
    if (!options.model || !options.model.trim()) {
      throw new EmbeddingError(
        "OpenAICompatEmbeddingProvider requires model",
      );
    }
    if (!Number.isFinite(options.dim) || options.dim <= 0) {
      throw new EmbeddingError(
        `OpenAICompatEmbeddingProvider requires positive dim (got ${options.dim})`,
      );
    }
    this.base_url = options.base_url.trim().replace(/\/+$/, "");
    this.api_key = (options.api_key ?? "").trim();
    this.model = options.model.trim();
    this.organization = options.organization?.trim() || null;
    this.dim = options.dim;
    this.batch_size = options.batch_size ?? DEFAULT_BATCH_SIZE;
    if (this.api_key && !isHeaderValueSafe(this.api_key)) {
      throw new EmbeddingError(
        "API key contains characters that are not allowed in HTTP headers " +
          "(newline, tab, or non-ASCII). Re-paste the key without any " +
          "surrounding whitespace.",
      );
    }
    if (this.organization && !isHeaderValueSafe(this.organization)) {
      throw new EmbeddingError(
        "Organization id contains characters that are not allowed in " +
          "HTTP headers. Strip whitespace and non-ASCII characters.",
      );
    }
    this.timeout_ms = options.timeout_ms ?? 60_000;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...(options.retry_policy ?? {}) };
    this.fetchImpl = options.fetchImpl
      ? options.fetchImpl
      : (globalThis.fetch as typeof fetch).bind(globalThis);
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.validate_dim = options.validate_dim ?? true;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult> {
    if (!texts.length) {
      return {
        vectors: [],
        model: this.model,
        usage: { prompt_tokens: 0 },
        raw: { object: "list", data: [] },
        duration_ms: 0,
      };
    }
    const t0 = nowMillis();
    const out: Float32Array[] = new Array(texts.length);
    let prompt_tokens = 0;
    let last_raw: unknown = null;
    let last_model = this.model;
    for (let i = 0; i < texts.length; i += this.batch_size) {
      const batch = texts.slice(i, i + this.batch_size);
      const result = await this.embedBatch(batch, signal);
      for (let j = 0; j < result.vectors.length; j += 1) {
        out[i + j] = result.vectors[j]!;
      }
      if (result.usage) prompt_tokens += result.usage.prompt_tokens;
      last_raw = result.raw;
      last_model = result.model;
    }
    return {
      vectors: out,
      model: last_model,
      usage: { prompt_tokens },
      raw: last_raw,
      duration_ms: nowMillis() - t0,
    };
  }

  private async embedBatch(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<EmbeddingResult> {
    const url = `${this.base_url}/embeddings`;
    // We deliberately omit `encoding_format`. The OpenAI spec defaults
    // it to "float", and proxies that don't natively understand the
    // field (e.g. LiteLLM in front of Voyage AI) reject the request
    // with `Value 'float' supplied`. Sending only the required fields
    // keeps us portable across every OpenAI-compat embedding endpoint.
    const body: Record<string, unknown> = {
      model: this.model,
      input: texts,
    };
    const attempts = this.retry.max_retries + 1;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const delay = delayFor(this.retry, attempt);
      if (delay > 0) await this.sleepImpl(delay * 1000, signal);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeout_ms);
      const onOuterAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });

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
        signal?.removeEventListener("abort", onOuterAbort);
        if (
          err instanceof DOMException &&
          err.name === "AbortError" &&
          signal?.aborted
        ) {
          throw err;
        }
        lastErr = err;
        if (attempt < attempts - 1) continue;
        throw new EmbeddingError(
          `network error talking to ${url}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      clearTimeout(timeout);
      signal?.removeEventListener("abort", onOuterAbort);

      if (response.ok) {
        const json = (await response.json()) as EmbeddingPayload;
        return parseEmbeddingPayload(
          json,
          this.model,
          this.dim,
          this.validate_dim,
        );
      }

      const text = await readBody(response);
      const detail = extractErrorDetail(text);
      if (response.status === 429) {
        const retry_after = parseRetryAfter(response.headers);
        if (
          retry_after != null &&
          retry_after > RATE_LIMIT_SHORT_WAIT_CAP_SECONDS
        ) {
          throw new EmbeddingRateLimitError(
            `OpenAI-compatible embeddings rate limit: ${detail}`,
            { retry_after_seconds: retry_after, reason: text },
          );
        }
        if (attempt < attempts - 1) {
          if (retry_after != null && retry_after > 0) {
            await this.sleepImpl(retry_after * 1000, signal);
          }
          lastErr = new EmbeddingRateLimitError(`429`, {
            retry_after_seconds: retry_after,
            reason: text,
          });
          continue;
        }
        throw new EmbeddingRateLimitError(
          `OpenAI-compatible embeddings rate limit (after ${attempts} attempts): ${detail}`,
          { retry_after_seconds: retry_after, reason: text },
        );
      }

      if (
        DEFAULT_RETRYABLE_STATUSES.has(response.status) &&
        attempt < attempts - 1
      ) {
        lastErr = new EmbeddingHttpError(
          `${response.status}: ${detail}`,
          response.status,
        );
        continue;
      }

      throw new EmbeddingHttpError(
        `OpenAI-compatible embeddings ${response.status}: ${detail}`,
        response.status,
      );
    }

    if (lastErr instanceof EmbeddingError) throw lastErr;
    throw new EmbeddingError(
      `embedding retry loop exited without a result (last error: ${lastErr})`,
    );
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.api_key) h.Authorization = `Bearer ${this.api_key}`;
    if (this.organization) h["OpenAI-Organization"] = this.organization;
    return h;
  }
}

interface EmbeddingPayload {
  object?: string;
  data?: { object?: string; index?: number; embedding?: number[] }[];
  model?: string;
  usage?: { prompt_tokens?: number | null; total_tokens?: number | null } | null;
  [k: string]: unknown;
}

function parseEmbeddingPayload(
  payload: EmbeddingPayload,
  fallback_model: string,
  dim: number,
  validate_dim: boolean,
): EmbeddingResult {
  if (!Array.isArray(payload.data) || !payload.data.length) {
    throw new EmbeddingError("embedding response missing `data` array");
  }
  const sorted = [...payload.data].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  const vectors: Float32Array[] = sorted.map((row, idx) => {
    if (!Array.isArray(row.embedding)) {
      throw new EmbeddingError(
        `embedding row ${idx} missing \`embedding\` array`,
      );
    }
    if (validate_dim && row.embedding.length !== dim) {
      throw new EmbeddingError(
        `embedding row ${idx} has dim ${row.embedding.length}, expected ${dim} ` +
          `(check that the configured "dim" matches the model)`,
      );
    }
    return Float32Array.from(row.embedding);
  });

  const usage_obj = payload.usage;
  const usage: EmbeddingUsage | null = usage_obj
    ? { prompt_tokens: Math.max(0, Number(usage_obj.prompt_tokens ?? 0) | 0) }
    : null;
  return {
    vectors,
    model: payload.model || fallback_model,
    usage,
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
 * Pull the most actionable error string out of an OpenAI-style error
 * body. Common shapes:
 *
 * - `{"error":{"message":"...","type":"...","code":"..."}}` (OpenAI / Azure)
 * - `{"error":{"message":"litellm.RateLimitError: ..."}}` (LiteLLM proxy)
 * - `{"detail":"..."}` (FastAPI / litellm passthrough)
 * - Plain text / HTML fallback
 *
 * We prefer the deepest `message`/`detail` we can find so curators see
 * "You exceeded your current quota..." instead of "429: {...nested...}".
 */
function extractErrorDetail(text: string): string {
  if (!text) return "(empty body)";
  try {
    const parsed = JSON.parse(text) as unknown;
    const found = pickErrorMessage(parsed);
    if (found) return truncate(found, 400);
  } catch {
    // Fall through to the raw-text path; some endpoints serve HTML.
  }
  return truncate(text.replace(/\s+/g, " ").trim(), 400);
}

function pickErrorMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length) return value.trim();
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  // OpenAI and most compatible servers nest the human-readable
  // string under `error.message`. Walk that path before any others.
  const ordered_keys = ["message", "detail", "error", "errors", "data"];
  for (const key of ordered_keys) {
    if (key in obj) {
      const inner = pickErrorMessage(obj[key]);
      if (inner) return inner;
    }
  }
  // Last resort: scan the object's own values.
  for (const v of Object.values(obj)) {
    const inner = pickErrorMessage(v);
    if (inner) return inner;
  }
  return null;
}

function isHeaderValueSafe(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code > 0xff) return false;
  }
  return true;
}
