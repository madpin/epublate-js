/**
 * Ollama-specific request options + curator-facing metadata.
 *
 * Why a dedicated module? The wider codebase is "OpenAI-compatible
 * only" by policy, but Ollama's OpenAI-compat endpoint quietly accepts
 * an extra top-level `options` object that maps to its native
 * Modelfile knobs (`num_ctx`, `num_predict`, `top_k`, `top_p`,
 * `repeat_penalty`, `mirostat`, …). Setting `num_ctx` is the single
 * biggest lever for translation quality — the default 2048-token
 * window is too small for most chapter-sized prompts and silently
 * truncates source text mid-translation.
 *
 * The OpenAI-compat provider already ignores unknown body fields, so
 * this is *additive*: we send `options` only when the curator opts in
 * via Settings → Ollama options. Cloud providers (OpenAI, OpenRouter,
 * Together, Groq, …) silently ignore the extra field.
 *
 * Layout:
 *
 * - `OllamaOptions` — the typed payload shape stored in the library
 *   DB and forwarded to `OpenAICompatProvider`.
 * - `OLLAMA_OPTION_FIELDS` — declarative metadata (label,
 *   description, defaults, ranges) used by the Settings card so the
 *   UI / docs / wire format share one source of truth.
 * - `OLLAMA_PRESETS` — opinionated starting points for translation
 *   work; the card surfaces them as one-click chips.
 * - `looksLikeOllamaUrl` / `sanitizeOllamaOptions` /
 *   `buildOllamaBodyExtras` — pure helpers reused by the card and
 *   the provider.
 *
 * Hard rule: every value sent on the wire must round-trip through
 * `sanitizeOllamaOptions`. The provider only sees finite numbers in
 * documented ranges, so a curator who pastes garbage into the form
 * never trips a `400` from Ollama.
 */

/**
 * Ollama runtime options that materially affect translation quality,
 * cost, or latency. Every field is optional; `undefined` means "let
 * Ollama use its built-in default" — we never send a field the
 * curator hasn't touched.
 *
 * Two wire locations:
 *
 * - **Modelfile knobs** (`num_ctx`, `num_predict`, sampling,
 *   Mirostat) ride in the `options` body object. Ollama maps them
 *   onto the underlying Modelfile parameters.
 * - **Top-level fields** (`think`) ride at the top of the request
 *   body. `think: false` disables thinking/chain-of-thought on
 *   thinking-capable models (Qwen 3, DeepSeek-R1, Gemma 3 thinking,
 *   GPT-OSS reasoning) — see https://docs.ollama.com/capabilities/thinking.
 *
 * `OLLAMA_OPTION_FIELDS` carries the `wire_location` discriminator
 * so `buildOllamaBodyExtras` can route each field correctly. Cloud
 * providers ignore both — the field types stay additive.
 */
export interface OllamaOptions {
  /**
   * Context window in tokens. Ollama's stock default is 2048, which
   * is *small* — a single Reader-pane segment plus the translator
   * system prompt typically consumes 1500+ tokens, leaving ~500 for
   * the source text. Bumping this to 8192 (or 16384 for a Llama
   * 3.1+ model) is the single most impactful tweak for chapter-sized
   * translations.
   */
  num_ctx?: number;
  /**
   * Hard cap on generated tokens. `-1` means "as many as the model
   * wants" (Ollama default). Set this to bound responses for
   * reliability — e.g. 2048 for translation work where a runaway
   * generation would otherwise eat the budget cap silently.
   */
  num_predict?: number;
  /**
   * Sampling temperature. Ollama default is 0.8; we recommend ~0.3
   * for translation (lower = more literal, fewer hallucinations).
   * Note: this *also* gets sent as the standard OpenAI `temperature`
   * field by `OpenAICompatProvider`. Setting it under
   * `ollama_options` lets the curator pin different behaviour for
   * Ollama specifically without affecting other providers.
   */
  temperature?: number;
  /**
   * Top-K sampling — picks among the K highest-probability next
   * tokens. Ollama default is 40. Lower (10–20) = more focused;
   * higher (60–100) = more variety. Below 1 disables.
   */
  top_k?: number;
  /**
   * Top-P (nucleus) sampling — picks the smallest set of next-token
   * candidates whose probabilities sum to P. Default 0.9; lower
   * tightens the distribution.
   */
  top_p?: number;
  /**
   * Penalty applied to tokens that recently appeared, to discourage
   * repetition. Ollama default 1.1. Translation rarely needs more
   * than 1.2; >1.4 starts to feel unnatural.
   */
  repeat_penalty?: number;
  /**
   * Random seed. When set, Ollama produces deterministic output for
   * the same prompt, which is great for screenshots, regression
   * tests, and reproducing a specific translation. `OpenAICompat`
   * also forwards `seed` natively; setting it here narrows the
   * scope to Ollama-style options if the curator wants a separate
   * value.
   */
  seed?: number;
  /**
   * Mirostat sampling: 0 = disabled (default), 1 = original, 2 =
   * v2. Mirostat is an alternative to top-K/top-P that targets a
   * fixed perplexity, which can produce more consistent prose at
   * the cost of higher variance. Most curators leave this off.
   */
  mirostat?: 0 | 1 | 2;
  /**
   * Mirostat learning rate. Default 0.1. Only meaningful when
   * `mirostat > 0`.
   */
  mirostat_eta?: number;
  /**
   * Mirostat target perplexity. Default 5.0. Only meaningful when
   * `mirostat > 0`. Lower = more coherent / less diverse.
   */
  mirostat_tau?: number;
  /**
   * Toggle thinking / chain-of-thought on thinking-capable models.
   * `false` disables it (major latency win on Qwen 3, DeepSeek-R1,
   * Gemma 3 thinking, GPT-OSS reasoning). `true` is the default for
   * thinking-enabled models since Ollama PR #12533, so explicitly
   * setting it to `true` is rarely necessary. Cloud providers
   * silently ignore the field.
   *
   * Note: when `reasoning_effort: "none"` is also set, Ollama treats
   * either signal as "disable thinking". Setting both is harmless —
   * the field is for curators who need an explicit per-request
   * boolean (e.g. some clients only honour `think`, not
   * `reasoning_effort`).
   *
   * Wire-format: top-level body field (NOT nested in `options`).
   */
  think?: boolean;
}

/**
 * Field key on `OllamaOptions`. Note: the value type varies — most
 * keys are numbers, `think` is a boolean. Form code dispatches on
 * `OllamaOptionField.kind`.
 */
export type OllamaOptionKey = keyof OllamaOptions;

/**
 * Declarative metadata for one Ollama option. The Settings card
 * iterates this list to render labels, helper text, range hints, and
 * default placeholders — so adding a new field here is the *only*
 * place a UI change is needed. Keep `default_value` in sync with
 * Ollama's documented stock defaults; we use them as input
 * placeholders, never as silent overrides.
 *
 * Discriminated by `kind`:
 *
 * - `kind: "number"` — numeric Modelfile knob; the form renders an
 *   `<input type="number">` (or `<select>` when `enum_values` is set).
 * - `kind: "boolean"` — boolean toggle; the form renders a checkbox.
 *
 * And by `wire_location`:
 *
 * - `wire_location: "options"` — nested under the `options` body
 *   field (Modelfile knobs).
 * - `wire_location: "top_level"` — at the top of the request body
 *   (e.g. `think`).
 */
export type OllamaOptionField =
  | OllamaNumberOptionField
  | OllamaBooleanOptionField;

interface OllamaOptionFieldBase {
  key: OllamaOptionKey;
  label: string;
  /** One-sentence summary surfaced under the input. */
  short_description: string;
  /**
   * Longer prose used in the help tooltip / popover. Plain English
   * — no markdown, no inline code; the card formats numerics on its
   * own.
   */
  long_description: string;
  /**
   * Visibility tier. The Settings card hides "advanced" rows by
   * default behind a "Show advanced options" toggle so most curators
   * only see `num_ctx`, `num_predict`, `temperature`, `repeat_penalty`,
   * and `think`. The `mirostat*` family lives in advanced.
   */
  tier: "common" | "advanced";
  /**
   * Where the value goes on the wire. Numeric Modelfile knobs ride
   * inside `body.options.*`; top-level toggles like `think` ride
   * directly on the request body.
   */
  wire_location: "options" | "top_level";
}

export interface OllamaNumberOptionField extends OllamaOptionFieldBase {
  kind: "number";
  /**
   * Ollama's stock default. Used as the input placeholder so the
   * curator sees what they're overriding. `null` means there's no
   * single sensible default we want to suggest.
   */
  default_value: number | null;
  /**
   * Recommended translation-friendly value. Surfaced in a small
   * "epublate suggests" hint; presets use the same numbers.
   */
  recommended_value: number | null;
  step: number;
  min?: number;
  max?: number;
  /** Whether the value must be an integer (the form coerces). */
  integer: boolean;
  /**
   * Optional list of valid integer values (Mirostat: 0 / 1 / 2).
   * When present, the form renders a `<select>` instead of a number
   * input.
   */
  enum_values?: { value: number; label: string }[];
}

export interface OllamaBooleanOptionField extends OllamaOptionFieldBase {
  kind: "boolean";
  /**
   * Ollama's stock default. Used to label the "use default" choice
   * in the tri-state form (true / false / inherit-default).
   */
  default_value: boolean | null;
  /** Recommended value for translation work. */
  recommended_value: boolean | null;
}

export const OLLAMA_OPTION_FIELDS: readonly OllamaOptionField[] = [
  {
    key: "think",
    label: "Disable thinking (think: false)",
    short_description:
      "Skip chain-of-thought on Qwen 3 / DeepSeek-R1 / Gemma 3 thinking. Major latency win.",
    long_description:
      "Sets the top-level Ollama `think` parameter. " +
      "false disables internal reasoning on thinking-capable models — " +
      "Qwen 3, DeepSeek-R1, Gemma 3 thinking, GPT-OSS reasoning — " +
      "which can be 5× faster for translation work where the chain-of-" +
      "thought adds little value. true keeps thinking on. Leave " +
      "unset (\"use model default\") for most curators; thinking-enabled " +
      "models default to true, others default to false. Cloud providers " +
      "ignore the field entirely. " +
      "Tip: setting Reasoning effort to \"none\" in the LLM card achieves " +
      "the same thing via OpenAI-compat. Setting both is harmless.",
    default_value: null,
    recommended_value: false,
    kind: "boolean",
    wire_location: "top_level",
    tier: "common",
  },
  {
    key: "num_ctx",
    label: "Context window (num_ctx)",
    short_description:
      "Tokens the model sees per request. Bigger window = fewer truncated chapters.",
    long_description:
      "Sets the number of tokens Ollama loads into context for a single chat. " +
      "The stock default is 2048, which fits maybe one or two segments plus " +
      "the translator system prompt — anything longer is silently truncated. " +
      "For epublate's chapter-batch flow, bump this to 8192 or 16384 if your " +
      "model and GPU/RAM can hold it. Doubling the window roughly doubles " +
      "memory cost; if Ollama OOMs, drop back to 4096.",
    default_value: 2048,
    recommended_value: 8192,
    step: 256,
    min: 256,
    max: 131072,
    integer: true,
    kind: "number",
    wire_location: "options",
    tier: "common",
  },
  {
    key: "num_predict",
    label: "Max output tokens (num_predict)",
    short_description:
      "Hard cap on generated tokens. -1 means \"let the model decide\".",
    long_description:
      "Caps how long the model's reply can be. -1 (the Ollama default) lets " +
      "the model run until it emits an end-of-turn marker, which is fine for " +
      "translation but can occasionally run away and burn through your " +
      "budget cap. Setting this to ~2048 keeps a single segment-translation " +
      "response well-bounded.",
    default_value: -1,
    recommended_value: 2048,
    step: 64,
    min: -1,
    max: 32768,
    integer: true,
    kind: "number",
    wire_location: "options",
    tier: "common",
  },
  {
    key: "temperature",
    label: "Temperature",
    short_description:
      "Higher = more creative / variable. Translation prefers low (0.2–0.4).",
    long_description:
      "Controls randomness in token selection. Ollama default is 0.8, which " +
      "is great for chat but a little loose for translation — 0.2–0.4 " +
      "produces tighter, more literal output and far fewer hallucinations. " +
      "Note: this also gets sent as the OpenAI-style temperature field, so " +
      "leaving it unset here means epublate uses whatever the rest of the " +
      "request specifies.",
    default_value: 0.8,
    recommended_value: 0.3,
    step: 0.05,
    min: 0,
    max: 2,
    integer: false,
    kind: "number",
    wire_location: "options",
    tier: "common",
  },
  {
    key: "repeat_penalty",
    label: "Repeat penalty",
    short_description:
      "Penalty for echoing recent tokens. 1.0 disables, ~1.1 is standard.",
    long_description:
      "Discourages the model from repeating itself. Ollama default 1.1 is a " +
      "good baseline; bump to 1.15–1.2 if you see translation loops, drop " +
      "below 1.1 if the model starts paraphrasing legitimately repeated " +
      "phrases. >1.3 tends to feel unnatural.",
    default_value: 1.1,
    recommended_value: 1.1,
    step: 0.01,
    min: 0,
    max: 2,
    integer: false,
    kind: "number",
    wire_location: "options",
    tier: "common",
  },
  {
    key: "top_k",
    label: "Top-K",
    short_description:
      "Sample from the K most likely next tokens. Lower = more focused.",
    long_description:
      "Caps the candidate pool for each token to the K highest-probability " +
      "options. Default 40. Lower (10–20) makes output more deterministic; " +
      "higher (60–100) lets the model pick rarer continuations. Mostly " +
      "relevant when temperature is non-zero.",
    default_value: 40,
    recommended_value: 40,
    step: 1,
    min: 0,
    max: 1000,
    integer: true,
    kind: "number",
    wire_location: "options",
    tier: "advanced",
  },
  {
    key: "top_p",
    label: "Top-P (nucleus)",
    short_description:
      "Smallest token set whose total probability ≥ P. Lower = tighter.",
    long_description:
      "Picks tokens from the smallest set whose cumulative probability " +
      "reaches P. Default 0.9. Combine with top-K, not as a replacement; " +
      "lowering to 0.7–0.8 alongside a low temperature gives the most " +
      "consistent translations.",
    default_value: 0.9,
    recommended_value: 0.9,
    step: 0.01,
    min: 0,
    max: 1,
    integer: false,
    kind: "number",
    wire_location: "options",
    tier: "advanced",
  },
  {
    key: "seed",
    label: "Seed",
    short_description:
      "Random seed. Set for deterministic output across runs.",
    long_description:
      "When set, Ollama emits the same tokens for the same prompt every " +
      "time — handy for reproducing a translation, regression-testing a " +
      "prompt change, or capturing screenshots. Leave empty for natural " +
      "stochastic output.",
    default_value: null,
    recommended_value: null,
    step: 1,
    integer: true,
    kind: "number",
    wire_location: "options",
    tier: "advanced",
  },
  {
    key: "mirostat",
    label: "Mirostat",
    short_description:
      "Adaptive sampling alternative to top-K / top-P. 0 = off.",
    long_description:
      "Mirostat targets a fixed perplexity instead of using top-K / top-P, " +
      "which can yield more consistent prose. Most curators leave this off " +
      "(0). Try 2 (Mirostat 2.0) if you see uneven output quality across " +
      "long chapters.",
    default_value: 0,
    recommended_value: 0,
    step: 1,
    integer: true,
    kind: "number",
    wire_location: "options",
    tier: "advanced",
    enum_values: [
      { value: 0, label: "0 — off (default)" },
      { value: 1, label: "1 — Mirostat" },
      { value: 2, label: "2 — Mirostat 2.0" },
    ],
  },
  {
    key: "mirostat_eta",
    label: "Mirostat η (eta)",
    short_description:
      "Mirostat learning rate. Only used when Mirostat is on.",
    long_description:
      "Learning rate for the Mirostat feedback loop. Default 0.1; ignored " +
      "when Mirostat is disabled.",
    default_value: 0.1,
    recommended_value: 0.1,
    step: 0.01,
    min: 0,
    max: 1,
    integer: false,
    kind: "number",
    wire_location: "options",
    tier: "advanced",
  },
  {
    key: "mirostat_tau",
    label: "Mirostat τ (tau)",
    short_description:
      "Mirostat target perplexity. Lower = more coherent.",
    long_description:
      "Target perplexity for Mirostat. Default 5.0; ignored when Mirostat " +
      "is disabled. Lower values produce more focused output, higher values " +
      "more diverse.",
    default_value: 5.0,
    recommended_value: 5.0,
    step: 0.1,
    min: 0,
    max: 20,
    integer: false,
    kind: "number",
    wire_location: "options",
    tier: "advanced",
  },
];

const FIELDS_BY_KEY: Readonly<Record<OllamaOptionKey, OllamaOptionField>> =
  Object.fromEntries(OLLAMA_OPTION_FIELDS.map((f) => [f.key, f])) as Record<
    OllamaOptionKey,
    OllamaOptionField
  >;

/**
 * Curator-facing presets. Each preset is a partial `OllamaOptions`
 * blob — the Settings card merges it onto the current draft so
 * fields the preset doesn't mention stay untouched. "Translation
 * (8K)" is the most common starting point and is what we recommend
 * to first-time Ollama users.
 */
export interface OllamaPreset {
  id: string;
  label: string;
  description: string;
  options: OllamaOptions;
}

export const OLLAMA_PRESETS: readonly OllamaPreset[] = [
  {
    id: "translation_8k",
    label: "Translation (8K context)",
    description:
      "Tight sampling, 8K context, thinking disabled. Sane default for any model that fits 8192 tokens — most curators should start here.",
    options: {
      num_ctx: 8192,
      num_predict: 2048,
      temperature: 0.3,
      top_k: 40,
      top_p: 0.9,
      repeat_penalty: 1.1,
      think: false,
    },
  },
  {
    id: "translation_long",
    label: "Long context (16K)",
    description:
      "Big context for chapter-sized batches. Needs a model + GPU that can hold 16K tokens; expect 2× memory vs the 8K preset. Thinking disabled.",
    options: {
      num_ctx: 16384,
      num_predict: 4096,
      temperature: 0.3,
      top_k: 40,
      top_p: 0.9,
      repeat_penalty: 1.1,
      think: false,
    },
  },
  {
    id: "deterministic",
    label: "Deterministic",
    description:
      "Temperature 0 + fixed seed + thinking off. Same prompt → same output every time. Best for regression-testing a glossary change.",
    options: {
      num_ctx: 8192,
      num_predict: 2048,
      temperature: 0,
      top_k: 1,
      top_p: 1,
      repeat_penalty: 1.1,
      seed: 42,
      think: false,
    },
  },
  {
    id: "creative",
    label: "Creative",
    description:
      "Looser sampling. Use with caution for translation — fine for tone-sniff or style experimentation, risky for a final pass.",
    options: {
      num_ctx: 8192,
      num_predict: 2048,
      temperature: 0.8,
      top_k: 60,
      top_p: 0.95,
      repeat_penalty: 1.05,
    },
  },
];

/**
 * Heuristic detection: does this base URL look like an Ollama
 * endpoint? Used by the Settings card to decide whether to surface
 * the Ollama-options card prominently or behind a disclosure
 * triangle. We never *block* the card on detection — sometimes
 * curators run Ollama behind a custom domain (`llm.example.lan`)
 * that the heuristic can't catch.
 */
export function looksLikeOllamaUrl(base_url: string | null | undefined): boolean {
  if (!base_url) return false;
  const url = base_url.trim().toLowerCase();
  if (!url) return false;
  // Default Ollama port: most local installs use this verbatim.
  if (url.includes(":11434")) return true;
  // Common containerised setup with a hostname.
  if (url.includes("ollama")) return true;
  return false;
}

/**
 * Permissive input type accepted by the sanitizer. Mirrors the
 * persisted shape (`OllamaOptionsLike` in `db/schema.ts`) — numeric
 * values are just `number` and booleans are just `boolean`, so we
 * can shovel raw Dexie rows in without the type system fighting
 * us. The sanitizer then narrows back to the strict `OllamaOptions`
 * interface (clamping ranges, narrowing `mirostat` to its enum).
 */
export type OllamaOptionsInput = {
  num_ctx?: number;
  num_predict?: number;
  temperature?: number;
  top_k?: number;
  top_p?: number;
  repeat_penalty?: number;
  seed?: number;
  mirostat?: number;
  mirostat_eta?: number;
  mirostat_tau?: number;
  think?: boolean;
};

/**
 * Drop fields whose value is undefined / null / empty so the
 * provider only sees explicit overrides. Accepts the permissive
 * `OllamaOptionsInput` (matches the persisted Dexie shape) and
 * returns the strict `OllamaOptions` interface — narrowing
 * `mirostat` from `number` to `0 | 1 | 2` and clamping every
 * range. Returns `null` when the sanitized blob is empty so
 * callers can skip sending the body field entirely.
 */
export function sanitizeOllamaOptions(
  raw: OllamaOptionsInput | null | undefined,
): OllamaOptions | null {
  if (!raw) return null;
  const out: Record<string, number | boolean> = {};
  for (const field of OLLAMA_OPTION_FIELDS) {
    const value = (raw as Record<string, number | boolean | undefined>)[
      field.key
    ];
    if (value == null) continue;
    if (field.kind === "boolean") {
      if (typeof value !== "boolean") continue;
      out[field.key] = value;
      continue;
    }
    // kind === "number"
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    let coerced = value;
    if (field.integer) coerced = Math.trunc(coerced);
    if (field.min != null && coerced < field.min) coerced = field.min;
    if (field.max != null && coerced > field.max) coerced = field.max;
    if (field.enum_values && !field.enum_values.some((e) => e.value === coerced)) {
      // Reject mirostat values outside {0, 1, 2}.
      continue;
    }
    out[field.key] = coerced;
  }
  if (Object.keys(out).length === 0) return null;
  // The runtime checks above guarantee every key is one of the
  // documented `OllamaOptions` keys with a value in range, so the
  // structural cast is sound — TypeScript can't see across the
  // `OLLAMA_OPTION_FIELDS` table.
  return out as unknown as OllamaOptions;
}

/**
 * Wire-format helper. Returns the body fragment ready to be spread
 * into the chat-completion request body:
 *
 * - Modelfile knobs (e.g. `num_ctx`, `temperature`) ride under
 *   `body.options.*` — Ollama maps them onto the underlying
 *   Modelfile parameters.
 * - Top-level toggles (e.g. `think`) ride at the top of the body —
 *   Ollama exposes them as named request fields.
 *
 * Returns an empty object when nothing is configured, so the call
 * site can `Object.assign(payload, …)` without conditionals. Cloud
 * providers ignore both sets of unknown fields.
 */
export function buildOllamaBodyExtras(
  options: OllamaOptionsInput | null | undefined,
): Record<string, unknown> {
  const sane = sanitizeOllamaOptions(options);
  if (!sane) return {};
  const modelfile: Record<string, number> = {};
  const top_level: Record<string, unknown> = {};
  for (const field of OLLAMA_OPTION_FIELDS) {
    const v = (sane as Record<string, number | boolean | undefined>)[field.key];
    if (v == null) continue;
    if (field.wire_location === "options") {
      // After sanitization, `kind: "number"` always carries a number.
      if (typeof v === "number") modelfile[field.key] = v;
    } else {
      top_level[field.key] = v;
    }
  }
  const out: Record<string, unknown> = {};
  if (Object.keys(modelfile).length > 0) out.options = modelfile;
  Object.assign(out, top_level);
  return out;
}

/** Lookup helper: get the metadata for a single field key. */
export function ollamaOptionField(
  key: OllamaOptionKey,
): OllamaOptionField {
  return FIELDS_BY_KEY[key];
}

/** Empty-options sentinel — used by the Settings card on first open. */
export const EMPTY_OLLAMA_OPTIONS: OllamaOptions = {};
