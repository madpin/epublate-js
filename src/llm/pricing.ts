/**
 * Per-model pricing table (mirrors `epublate.llm.pricing`).
 *
 * Used to label every `llm_call` row with a `cost_usd` so the cost
 * meter, batch budget cap, and audit bundle have first-class numbers.
 * Costs are stored in **USD per million tokens** because most public
 * price sheets (OpenAI, Anthropic, Google, DeepSeek) are denominated
 * that way; multiplying by ``tokens / 1_000_000`` keeps the math
 * obvious in the call site.
 *
 * Lookup is forgiving: an exact `model` name wins, then we strip the
 * trailing `-YYYY-MM-DD` date stamp the OpenAI API returns, then we
 * try the longest registered prefix (so `gpt-4o-mini-2024-07-18`
 * resolves to `gpt-4o-mini`). Local / OSS endpoints (`llama3:70b`,
 * `mistral`) miss every fallback and bill at zero — which is what we
 * want for free providers, *but* doesn't help curators running paid
 * models behind a proxy whose slugs don't match any default. For
 * those, the Settings screen ships a "Custom pricing" surface that
 * persists overrides and re-applies them on every page load via
 * :func:`applyPricingOverrides`.
 */

export interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
}

/**
 * Conservative public prices snapshotted at PRD authoring time. The
 * goal isn't to track every provider's price changes (the table is
 * editable); it's to spare the curator from registering pricing for
 * the most common models they're likely to drop into the LLM config.
 */
const DEFAULTS: Record<string, ModelPrice> = {
  // OpenAI · GPT-5 family.
  "gpt-5": { input_per_mtok: 1.25, output_per_mtok: 10.0 },
  "gpt-5-mini": { input_per_mtok: 0.25, output_per_mtok: 2.0 },
  "gpt-5-nano": { input_per_mtok: 0.05, output_per_mtok: 0.4 },
  // OpenAI · GPT-4 family.
  "gpt-4o": { input_per_mtok: 2.5, output_per_mtok: 10.0 },
  "gpt-4o-mini": { input_per_mtok: 0.15, output_per_mtok: 0.6 },
  "gpt-4-turbo": { input_per_mtok: 10.0, output_per_mtok: 30.0 },
  "gpt-4.1": { input_per_mtok: 2.0, output_per_mtok: 8.0 },
  "gpt-4.1-mini": { input_per_mtok: 0.4, output_per_mtok: 1.6 },
  "gpt-4.1-nano": { input_per_mtok: 0.1, output_per_mtok: 0.4 },
  "gpt-4": { input_per_mtok: 30.0, output_per_mtok: 60.0 },
  // OpenAI · reasoning / o-series.
  o1: { input_per_mtok: 15.0, output_per_mtok: 60.0 },
  "o1-mini": { input_per_mtok: 1.1, output_per_mtok: 4.4 },
  o3: { input_per_mtok: 10.0, output_per_mtok: 40.0 },
  "o3-mini": { input_per_mtok: 1.1, output_per_mtok: 4.4 },
  "o4-mini": { input_per_mtok: 1.1, output_per_mtok: 4.4 },
  // OpenAI · legacy.
  "gpt-3.5-turbo": { input_per_mtok: 0.5, output_per_mtok: 1.5 },
  // Anthropic · Claude.
  "claude-opus-4": { input_per_mtok: 15.0, output_per_mtok: 75.0 },
  "claude-sonnet-4": { input_per_mtok: 3.0, output_per_mtok: 15.0 },
  "claude-3-7-sonnet": { input_per_mtok: 3.0, output_per_mtok: 15.0 },
  "claude-3-5-sonnet": { input_per_mtok: 3.0, output_per_mtok: 15.0 },
  "claude-3-5-haiku": { input_per_mtok: 0.8, output_per_mtok: 4.0 },
  "claude-3-haiku": { input_per_mtok: 0.25, output_per_mtok: 1.25 },
  "claude-3-opus": { input_per_mtok: 15.0, output_per_mtok: 75.0 },
  "claude-3-sonnet": { input_per_mtok: 3.0, output_per_mtok: 15.0 },
  // Google · Gemini.
  "gemini-2.5-pro": { input_per_mtok: 1.25, output_per_mtok: 10.0 },
  "gemini-2.5-flash": { input_per_mtok: 0.3, output_per_mtok: 2.5 },
  "gemini-2.5-flash-lite": { input_per_mtok: 0.1, output_per_mtok: 0.4 },
  "gemini-2.0-flash": { input_per_mtok: 0.1, output_per_mtok: 0.4 },
  "gemini-2.0-flash-lite": { input_per_mtok: 0.075, output_per_mtok: 0.3 },
  "gemini-1.5-pro": { input_per_mtok: 1.25, output_per_mtok: 5.0 },
  "gemini-1.5-flash": { input_per_mtok: 0.075, output_per_mtok: 0.3 },
  // DeepSeek (public API).
  "deepseek-chat": { input_per_mtok: 0.27, output_per_mtok: 1.1 },
  "deepseek-reasoner": { input_per_mtok: 0.55, output_per_mtok: 2.19 },
  "deepseek-r1": { input_per_mtok: 0.55, output_per_mtok: 2.19 },
  "deepseek-v3": { input_per_mtok: 0.27, output_per_mtok: 1.1 },
  "deepseek-v3.1": { input_per_mtok: 0.27, output_per_mtok: 1.1 },
  "deepseek-v3.2-exp": { input_per_mtok: 0.27, output_per_mtok: 0.41 },
  "deepseek-coder": { input_per_mtok: 0.14, output_per_mtok: 0.28 },
  // xAI · Grok (rough public pricing).
  "grok-4": { input_per_mtok: 3.0, output_per_mtok: 15.0 },
  "grok-3": { input_per_mtok: 3.0, output_per_mtok: 15.0 },
  "grok-3-mini": { input_per_mtok: 0.3, output_per_mtok: 0.5 },
  // Alibaba · Qwen.
  "qwen3-max": { input_per_mtok: 1.6, output_per_mtok: 6.4 },
  "qwen3-coder-plus": { input_per_mtok: 1.0, output_per_mtok: 5.0 },
  "qwen2.5-72b": { input_per_mtok: 0.9, output_per_mtok: 0.9 },
  // Test sentinel.
  mock: { input_per_mtok: 0.0, output_per_mtok: 0.0 },
};

const UNKNOWN: ModelPrice = { input_per_mtok: 0, output_per_mtok: 0 };

const TABLE: Record<string, ModelPrice> = { ...DEFAULTS };

/**
 * Snapshot of user-defined overrides currently in the table; lets the
 * Settings screen render the "your custom prices" list without
 * re-walking the merged table.
 */
let OVERRIDES: Record<string, ModelPrice> = {};

const DATE_SUFFIX_RE = /-\d{4}-\d{2}-\d{2}$/;

export function getPrice(model: string): ModelPrice {
  if (TABLE[model]) return TABLE[model];
  const stripped = model.replace(DATE_SUFFIX_RE, "");
  if (stripped !== model && TABLE[stripped]) return TABLE[stripped];
  const parts = stripped.split("-");
  while (parts.length > 1) {
    parts.pop();
    const prefix = parts.join("-");
    if (TABLE[prefix]) return TABLE[prefix];
  }
  return UNKNOWN;
}

/** True when the model resolves to a non-zero price (default or override). */
export function hasPrice(model: string): boolean {
  const price = getPrice(model);
  return price.input_per_mtok > 0 || price.output_per_mtok > 0;
}

export function setPrice(model: string, price: ModelPrice): void {
  TABLE[model] = price;
}

/**
 * Reset the working table to the package defaults. Drops user
 * overrides — typically the caller follows up with
 * :func:`applyPricingOverrides` so the persisted overrides come back.
 */
export function resetPrices(): void {
  for (const k of Object.keys(TABLE)) delete TABLE[k];
  Object.assign(TABLE, DEFAULTS);
  OVERRIDES = {};
}

/**
 * Replace the current set of user overrides with `overrides`. Mirrors
 * what the Settings UI wants: drop the existing overrides, layer the
 * new ones on top of the defaults, then commit.
 */
export function applyPricingOverrides(
  overrides: Record<string, ModelPrice>,
): void {
  resetPrices();
  for (const [model, price] of Object.entries(overrides ?? {})) {
    TABLE[model] = price;
  }
  OVERRIDES = { ...overrides };
}

/** Snapshot the active user overrides (defaults are not included). */
export function listPricingOverrides(): Record<string, ModelPrice> {
  return { ...OVERRIDES };
}

/**
 * Snapshot the full active pricing table including defaults. Useful
 * for the Settings UI which renders both default rows (read-only) and
 * user overrides (editable). Returns a fresh object so callers can
 * sort / filter without mutating the live table.
 */
export function listEffectivePricing(): Record<string, ModelPrice> {
  return { ...TABLE };
}

/** Snapshot the package defaults (read-only reference). */
export function listDefaultPricing(): Readonly<Record<string, ModelPrice>> {
  return DEFAULTS;
}

export function estimateCost(
  model: string,
  prompt_tokens: number,
  completion_tokens: number,
): number {
  if (prompt_tokens < 0 || completion_tokens < 0) {
    throw new Error("token counts must be non-negative");
  }
  const price = getPrice(model);
  return (
    (prompt_tokens * price.input_per_mtok) / 1_000_000 +
    (completion_tokens * price.output_per_mtok) / 1_000_000
  );
}
