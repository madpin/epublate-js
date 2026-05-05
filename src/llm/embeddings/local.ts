/**
 * Local embedding provider, backed by `@xenova/transformers`.
 *
 * Runs entirely on-device. The model weights live in the browser's
 * Cache Storage after the first download, so subsequent loads are
 * offline. WebGPU is preferred when available; we fall back to WASM
 * (which works in every modern browser, just ~5× slower).
 *
 * # Privacy & network policy
 *
 * The default model is `Xenova/multilingual-e5-small` (~120 MB; 384-
 * dim). Curators must explicitly opt in via the Settings → Embeddings
 * card; until they do, this provider throws
 * `EmbeddingConsentRequiredError` and the rest of the codebase falls
 * back to the "no-retrieval" path. The consent state is persisted in
 * `localStorage` under `epublate-embedding-consent`.
 *
 * The first activation downloads the weights from `huggingface.co`.
 * That's the only third-party network call this provider ever makes;
 * all subsequent embed() calls are 100 % offline. This exception is
 * documented in `.cursor/rules/no-network-side-effects.mdc` and
 * `AGENTS.md`.
 *
 * # Lazy import
 *
 * `@xenova/transformers` is bundled as a dynamic import so projects
 * that never enable local embeddings don't pay the bundle cost. Tests
 * exercise the rest of the embedding layer through the OpenAI-compat
 * and mock providers; the local provider is exercised at runtime by
 * curators that opt in.
 */

import {
  type EmbeddingProvider,
  type EmbeddingResult,
  EmbeddingConsentRequiredError,
  EmbeddingError,
} from "./base";

/** Default checkpoint — 384-dim multilingual model, ~120 MB on disk. */
export const DEFAULT_LOCAL_MODEL = "Xenova/multilingual-e5-small";
export const DEFAULT_LOCAL_DIM = 384;
export const APPROX_LOCAL_MODEL_BYTES = 120 * 1024 * 1024;
export const HF_BASE_URL = "https://huggingface.co";

const CONSENT_LS_KEY = "epublate-embedding-consent";

/**
 * Cache-purge bookmark. Bumping the version invalidates any
 * `transformers-cache` entries the curator might have on disk from
 * an older build that still let transformers.js fall back to
 * `${origin}/models/...` (and ended up caching the SPA's index.html
 * as if it were a config.json). The purge runs once per session and
 * is recorded in `localStorage`.
 */
const CACHE_PURGE_KEY = "epublate-embedding-cache-purge";
const CACHE_PURGE_VERSION = "1";

async function maybePurgeStaleTransformersCache(): Promise<void> {
  if (typeof self === "undefined" || !("caches" in self)) return;
  if (typeof localStorage === "undefined") return;
  if (localStorage.getItem(CACHE_PURGE_KEY) === CACHE_PURGE_VERSION) return;
  try {
    await caches.delete("transformers-cache");
  } catch {
    // best-effort; if Cache Storage is locked we just retry next session.
  }
  localStorage.setItem(CACHE_PURGE_KEY, CACHE_PURGE_VERSION);
}

export interface LocalEmbeddingProviderOptions {
  model?: string;
  dim?: number;
  batch_size?: number;
  /** Override the consent gate; tests pass `true` to skip the dialog. */
  consent_granted?: boolean;
  /** Test seam: pre-built `pipeline` factory. */
  pipelineImpl?: PipelineFactory;
}

/**
 * Curator-grants the network exception. Persisted in localStorage so
 * subsequent sessions don't re-prompt. The Settings UI can revoke it
 * (see {@link revokeLocalEmbeddingConsent}).
 */
export function grantLocalEmbeddingConsent(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(CONSENT_LS_KEY, "1");
}

export function revokeLocalEmbeddingConsent(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(CONSENT_LS_KEY);
}

export function hasLocalEmbeddingConsent(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(CONSENT_LS_KEY) === "1";
}

type PipelineFactory = (
  task: string,
  model: string,
  options?: Record<string, unknown>,
) => Promise<EmbedderFn>;

type EmbedderFn = (
  texts: string[],
  options?: Record<string, unknown>,
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

let cachedPipeline: Promise<EmbedderFn> | null = null;
let cachedModel: string | null = null;

/**
 * Resolve the active `pipeline()` factory. Real callers go through
 * `await import("@xenova/transformers")`; tests inject `pipelineImpl`.
 *
 * Returns `null` when the dependency is absent (so the factory can
 * surface a friendly error instead of crashing the bundler).
 *
 * **Important env tweak.** Transformers.js's default `env` is tuned
 * for Node + a `./models` filesystem mirror — in a static SPA, its
 * relative-URL fetch lands on the dev server's `index.html`
 * fallback and produces the infamous `Unexpected token '<', "<!doctype "...`
 * JSON parse failure. We disable local-model lookup and pin the
 * remote host so the library always pulls weights from HuggingFace.
 */
async function loadPipelineFactory(): Promise<PipelineFactory | null> {
  try {
    // Dynamic import so the bundler keeps this in a separate chunk
    // and projects that never enable local embeddings don't pay the
    // ~5 MB transformers bundle cost.
    const mod: unknown = await import(
      /* @vite-ignore */ "@xenova/transformers"
    );
    const candidate = (mod as { pipeline?: unknown }).pipeline;
    if (typeof candidate !== "function") return null;
    // Configure transformers.js for a browser-only deployment.
    // Failing to do this is the cause of the curator-facing
    // "Unexpected token '<', '<!doctype'..." error: the library
    // walks `./models/<repo>/<file>` first, the dev server falls
    // back to `index.html`, and JSON.parse explodes on the HTML.
    const env = (
      mod as {
        env?: {
          allowLocalModels?: boolean;
          allowRemoteModels?: boolean;
          useBrowserCache?: boolean;
          remoteHost?: string;
          remotePathTemplate?: string;
        };
      }
    ).env;
    if (env) {
      // Disable the on-origin `./models/` lookup. With this set to
      // its default (`true`), transformers.js fetches files from the
      // dev server's `index.html` fallback first and JSON.parse blows
      // up on the HTML; flip it off so the resolver goes straight to
      // HuggingFace.
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      // The resolver expects the trailing slash in both. We don't
      // touch `remotePathTemplate` — the library default already
      // produces `{model}/resolve/{revision}/` which is what the Hub
      // serves.
      env.remoteHost = `${HF_BASE_URL}/`;
    }
    return candidate as PipelineFactory;
  } catch {
    return null;
  }
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly model: string;
  readonly dim: number;
  readonly batch_size: number;

  private readonly consent_granted: boolean;
  private readonly pipelineImpl: PipelineFactory | null;

  constructor(options: LocalEmbeddingProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_LOCAL_MODEL;
    this.dim = options.dim ?? DEFAULT_LOCAL_DIM;
    this.batch_size = options.batch_size ?? 16;
    this.consent_granted =
      options.consent_granted ?? hasLocalEmbeddingConsent();
    this.pipelineImpl = options.pipelineImpl ?? null;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult> {
    if (!this.consent_granted) {
      throw new EmbeddingConsentRequiredError(
        `Local embedding model requires a one-time download from ${HF_BASE_URL}. ` +
          "Open Settings → Embeddings and click 'Download model' to grant consent.",
        {
          approximate_bytes: APPROX_LOCAL_MODEL_BYTES,
          source: `${HF_BASE_URL}/${this.model}`,
        },
      );
    }
    if (!texts.length) {
      return {
        vectors: [],
        model: this.model,
        usage: { prompt_tokens: 0 },
        raw: { local: true, model: this.model, count: 0 },
      };
    }
    const embedder = await this.embedder();
    const out: Float32Array[] = new Array(texts.length);
    let total_chars = 0;
    for (let i = 0; i < texts.length; i += this.batch_size) {
      if (signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      const batch = texts.slice(i, i + this.batch_size);
      // The transformers pipeline returns a flat `Float32Array` of
      // `(batch_size, dim)` plus `dims = [batch_size, dim]`. Slice
      // each row out into its own vector.
      const result = await embedder(batch, {
        pooling: "mean",
        normalize: true,
      });
      const flat =
        result.data instanceof Float32Array
          ? result.data
          : Float32Array.from(result.data);
      const [bs, dim] = result.dims;
      if (bs !== batch.length) {
        throw new EmbeddingError(
          `local embedder returned ${bs} vectors for ${batch.length} inputs`,
        );
      }
      if (dim !== this.dim) {
        throw new EmbeddingError(
          `local embedder returned dim ${dim}, expected ${this.dim} ` +
            `(check that the configured "dim" matches the model)`,
        );
      }
      for (let j = 0; j < batch.length; j += 1) {
        out[i + j] = flat.slice(j * dim, (j + 1) * dim);
        total_chars += batch[j]!.length;
      }
    }
    return {
      vectors: out,
      model: this.model,
      usage: { prompt_tokens: Math.max(0, Math.ceil(total_chars / 4)) },
      raw: { local: true, model: this.model, count: texts.length },
    };
  }

  private async embedder(): Promise<EmbedderFn> {
    if (cachedPipeline && cachedModel === this.model) {
      return cachedPipeline;
    }
    // Drop any stale `transformers-cache` entries left over from a
    // previous build that allowed local-model lookups (and ended up
    // caching the SPA's index.html under the local path). Idempotent
    // and gated on a localStorage version so we only do it once.
    await maybePurgeStaleTransformersCache();
    const factory =
      this.pipelineImpl ?? (await loadPipelineFactory());
    if (!factory) {
      throw new EmbeddingError(
        "local embedding provider requires `@xenova/transformers` to be " +
          "installed and bundled. Re-run `npm install` and reload the page.",
      );
    }
    // Wrap the lazy pipeline construction so we can rethrow the most
    // common transformers.js failure modes with a curator-friendly
    // hint. The `<!doctype` JSON parse error is what curators saw
    // before we forced `env.allowLocalModels = false`; we keep the
    // explicit branch in case another setup hits the same trap.
    const promise = factory("feature-extraction", this.model).catch(
      async (err: unknown) => {
        cachedPipeline = null;
        cachedModel = null;
        const msg = err instanceof Error ? err.message : String(err);
        if (
          /<!doctype/i.test(msg) ||
          msg.includes("Unexpected token '<'")
        ) {
          // Best-effort: blow away the stale cache *now* (the purge
          // gate already flipped on first launch, but the curator may
          // be on a build where it hadn't run yet). Then surface the
          // actionable hint.
          if (typeof self !== "undefined" && "caches" in self) {
            try {
              await caches.delete("transformers-cache");
            } catch {
              /* ignore */
            }
          }
          throw new EmbeddingError(
            `Local embedding model load failed: the cached response ` +
              `looks like your app's HTML, not a model file. This is ` +
              `the leftover from an earlier build that let transformers.js ` +
              `look in /models/. The cache has been cleared — please ` +
              `reload the page and click Test again.`,
          );
        }
        if (
          /failed to fetch|network|cors|err_failed|abort/i.test(msg)
        ) {
          throw new EmbeddingError(
            `Local embedding model download failed (${msg}). Check that ` +
              `${HF_BASE_URL} is reachable from this browser and try again.`,
          );
        }
        throw new EmbeddingError(
          `Local embedding pipeline failed to load: ${msg}`,
        );
      },
    );
    cachedPipeline = promise;
    cachedModel = this.model;
    return promise;
  }
}

/** Test-only: drop the cached pipeline so the next call re-loads it. */
export function resetLocalPipelineCache(): void {
  cachedPipeline = null;
  cachedModel = null;
}
