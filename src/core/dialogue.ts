/**
 * Best-effort dialogue detection for the translator's context window.
 *
 * When the curator opts into "dialogue-only context" the pipeline
 * needs to know whether the current segment is part of a conversation
 * before it decides which preceding segments (if any) to feed into
 * the prompt. Books vary by language: English wraps speech in `"…"`,
 * French in `«…»` or em-dash openers, Japanese in `「…」` / `『…』`,
 * Spanish in em-dash leaders, etc. We support the union of common
 * markers so the heuristic works without per-project configuration.
 *
 * The detector is intentionally liberal: false positives only mean
 * we include a couple more context rows than strictly needed, which
 * is much cheaper than missing a real exchange and shipping a
 * disconnected translation.
 */

/**
 * Quote-style pairs we treat as dialogue markers. The Right side
 * mirrors the left, but we tolerate mismatched/unbalanced runs (a
 * paragraph that opens with `“` but breaks before the closing `”`
 * still looks like dialogue to readers, so it should look like
 * dialogue to us).
 */
const QUOTE_OPENERS = [
  "\u201C", // “ left double quotation
  "\u201E", // „ low-9 double (German/Eastern European)
  "\u00AB", // « guillemet left
  "\u300C", // 「 corner bracket left (CJK)
  "\u300E", // 『 white corner bracket left (CJK)
  "\uFF02", // " fullwidth quotation mark
  "\u2018", // ‘ left single
  "\u201A", // ‚ low-9 single
  "\u2039", // ‹ single guillemet left
];

const QUOTE_CLOSERS = [
  "\u201D", // ” right double quotation
  "\u00BB", // » guillemet right
  "\u300D", // 」 corner bracket right
  "\u300F", // 』 white corner bracket right
  "\u2019", // ’ right single
  "\u203A", // › single guillemet right
];

/**
 * Em / en / horizontal-bar dash openers used by French and Spanish to
 * introduce direct speech (e.g. ``— Bonjour, dit-il.``).
 */
const DASH_OPENERS = ["\u2014", "\u2013", "\u2015"]; // — – ―

/**
 * True when the segment's source text reads like spoken dialogue.
 *
 * Detection layers:
 *   1. Contains balanced ASCII straight-quote pairs (`"…"`).
 *   2. Contains any non-ASCII opener listed in `QUOTE_OPENERS`.
 *   3. Begins with an em/en/horizontal-bar dash (with optional
 *      leading whitespace) — Romance-language speech leader.
 *
 * The function tolerates mismatched closers (real-world prose chops
 * dialogue across paragraphs) and extreme whitespace.
 */
export function isDialogueSegment(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Romance-language em-dash leader: line starts with an em / en /
  // horizontal-bar dash followed by space + uppercase or lowercase
  // letter. Reject the dashes that are *part* of a word (already
  // a less-common case but worth filtering false positives like
  // `prompt — engineering`).
  if (DASH_OPENERS.includes(trimmed[0] ?? "")) {
    const after = trimmed.slice(1).trimStart();
    if (after.length > 0) return true;
  }

  // CJK / European quote pairs: the presence of any opener is enough
  // to call it dialogue. Closers without openers (rare; only happens
  // when prose splits a long quotation across paragraphs) also count.
  for (const ch of QUOTE_OPENERS) {
    if (trimmed.includes(ch)) return true;
  }
  for (const ch of QUOTE_CLOSERS) {
    if (trimmed.includes(ch)) return true;
  }

  // ASCII straight-quote dialogue: at least one pair `"…"` containing
  // a letter. Plain inch / arc-second marks would also match, but
  // those rarely show up in literary prose.
  const ascii_pair = /"[^"]*[\p{L}\p{N}][^"]*"/u;
  if (ascii_pair.test(trimmed)) return true;

  return false;
}

export type ContextMode = "off" | "previous" | "dialogue";

export const CONTEXT_MODES: readonly ContextMode[] = [
  "previous",
  "dialogue",
  "off",
] as const;

export function isContextMode(value: unknown): value is ContextMode {
  return value === "off" || value === "previous" || value === "dialogue";
}
