/**
 * Token accounting (mirrors `epublate.llm.tokens`).
 *
 * The pipeline asks for a token count to size context budgets and to
 * estimate cost when the API response omits the `usage` block (Ollama,
 * older llama.cpp). We use `gpt-tokenizer` rather than a WASM port of
 * `tiktoken`: smaller bundle, pure JS, ships the BPE tables for the
 * cl100k / o200k encodings we actually need.
 *
 * Falls back to the same chars/4 heuristic the Python tool uses when
 * the model is unknown so the math is still monotonic and deterministic.
 *
 * Encoders are loaded lazily — importing this module is cheap, the
 * BPE table only lands when somebody actually counts.
 */

const KNOWN_CL100K = new Set<string>([
  "gpt-3.5-turbo",
  "gpt-4",
  "gpt-4-turbo",
]);
const KNOWN_O200K = new Set<string>([
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "o1",
  "o1-mini",
  "o3",
  "o3-mini",
  "o4-mini",
]);

let cl100k_mod: typeof import("gpt-tokenizer/encoding/cl100k_base") | null = null;
let o200k_mod: typeof import("gpt-tokenizer/encoding/o200k_base") | null = null;

async function ensureCl100k(): Promise<typeof cl100k_mod> {
  if (cl100k_mod) return cl100k_mod;
  cl100k_mod = await import("gpt-tokenizer/encoding/cl100k_base");
  return cl100k_mod;
}

async function ensureO200k(): Promise<typeof o200k_mod> {
  if (o200k_mod) return o200k_mod;
  o200k_mod = await import("gpt-tokenizer/encoding/o200k_base");
  return o200k_mod;
}

function familyOf(model: string): "cl100k" | "o200k" | null {
  const lower = model.toLowerCase();
  for (const known of KNOWN_O200K) {
    if (lower === known || lower.startsWith(`${known}-`)) return "o200k";
  }
  for (const known of KNOWN_CL100K) {
    if (lower === known || lower.startsWith(`${known}-`)) return "cl100k";
  }
  return null;
}

function heuristic(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.floor(text.length / 4));
}

/**
 * Async exact count via the BPE tokenizer when available.
 *
 * Heavy callers (the cost meter, cache key debug builds) should hit
 * `countTokensSync` instead; this is for places that genuinely need the
 * accurate number and don't mind awaiting the encoder load.
 */
export async function countTokens(
  text: string,
  options: { model?: string | null } = {},
): Promise<number> {
  if (!text) return 0;
  const family = options.model ? familyOf(options.model) : null;
  if (family === "o200k") {
    const mod = await ensureO200k();
    return mod ? mod.encode(text).length : heuristic(text);
  }
  if (family === "cl100k") {
    const mod = await ensureCl100k();
    return mod ? mod.encode(text).length : heuristic(text);
  }
  return heuristic(text);
}

/** Cheap chars/4 estimate; safe to call on the hot path. */
export function countTokensSync(text: string): number {
  return heuristic(text);
}
