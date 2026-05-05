/**
 * Helper-LLM extractor prompt builder + response parser.
 *
 * Verbatim port of `epublate.llm.prompts.extractor` (PRD §8.2 / M5).
 *
 * The extractor is the cheap, helper-model side of the pipeline:
 *
 *   - **Book intake** (PRD §7.1 step 5) — one-shot pass over the first
 *     few segments of a freshly-created project, seeding the glossary
 *     with `proposed` entries and a draft narrative POV/tense.
 *   - **Batch pre-pass** (PRD §4.2 step 3) — per-chapter scan that runs
 *     before the translator loop so the translator's prompt sees the
 *     new candidates immediately.
 *
 * This module is pure: it turns project state into `Message` objects
 * and turns the model's response back into a typed `ExtractorTrace`.
 * The pipeline owns the LLM call, the cache lookup, and the DB writes.
 */

import { LLMResponseError } from "@/llm/base";
import type { Message, ResponseFormat } from "@/llm/base";
import type { GlossaryConstraint } from "@/llm/prompts/translator";

export const EXTRACTOR_MAX_WORDS = 10;
export const EXTRACTOR_MAX_CHARS = 100;

/**
 * Default `response_format` for the helper-LLM extractor (PRD F-LLM-3).
 *
 * We pin `json_object` because the prompt asks for "a single JSON
 * object and nothing else" and the parser refuses prose. Without an
 * explicit structured-output hint, reasoning-style helpers (e.g.
 * `gpt-oss-20b`) can spend their visible-channel budget on reasoning
 * tokens and return empty content; permissive endpoints can wrap the
 * JSON in fences or commentary that defeats the recovery regex. JSON
 * mode constrains decoding so the model has to emit a parseable
 * object, eliminating both failure modes for the bulk of OpenAI-
 * compatible providers (OpenAI, LiteLLM, vLLM, Ollama, llama.cpp).
 */
export const DEFAULT_EXTRACTOR_RESPONSE_FORMAT: ResponseFormat = {
  type: "json_object",
};

export type EntityTypeLiteral =
  | "character"
  | "place"
  | "organization"
  | "event"
  | "item"
  | "date_or_time"
  | "phrase"
  | "term"
  | "other";

const VALID_TYPES: ReadonlySet<string> = new Set([
  "character",
  "place",
  "organization",
  "event",
  "item",
  "date_or_time",
  "phrase",
  "term",
  "other",
]);

export interface ExtractedEntity {
  type: EntityTypeLiteral;
  source: string;
  target: string | null;
  evidence: string | null;
  confidence: number;
}

export interface ExtractorTrace {
  entities: ExtractedEntity[];
  pov: string | null;
  tense: string | null;
  /** Aliased on the wire as `register` (clashes with `BaseModel.register` in Python). */
  narrative_register: string | null;
  /** Aliased on the wire as `audience`. */
  narrative_audience: string | null;
  notes: string | null;
}

const MULTI_SENTENCE_RE = /[.!?]\s+\S/;
const TRAILING_SENTENCE_RE = /[!?](?:\s|$)/;

function looksLikeSentence(term: string): boolean {
  if (MULTI_SENTENCE_RE.test(term)) return true;
  return TRAILING_SENTENCE_RE.test(term);
}

function hasUnbalancedParens(term: string): boolean {
  return (
    countChar(term, "(") !== countChar(term, ")") ||
    countChar(term, "[") !== countChar(term, "]") ||
    countChar(term, "{") !== countChar(term, "}")
  );
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n += 1;
  return n;
}

const ERA_MARKER_RE =
  /\b(?:AD|BC|BCE|CE|a\.?\s*C\.?|d\.?\s*C\.?|n\.?\s*Chr\.?|v\.?\s*Chr\.?)\b/gi;
const CIRCA_PREFIX_RE =
  /^\s*(?:c\.?|ca\.?|circa|cca\.?|approx\.?|aprox\.?)\s+/i;
const YEAR_LIKE_REMAINDER_RE = /^\d{1,4}(?:\s*[\-\u2013\u2014]\s*\d{1,4})?s?$/i;
const YEAR_TRAILING_PUNCT = /[.,;:!?]+$/;

/**
 * True if `term` is just a year, year range, or decade — these are not
 * worth tracking in the lore bible (PRD §8.2). Catches:
 *   - pure 1-4 digit years (`1066`, `1905`, `2024`)
 *   - year ranges (`1939-1945` and en-/em-dash variants)
 *   - decades (`1990s`)
 *   - era-qualified years (`1066 AD`, `45 BCE`, `1066 d.C.`)
 *   - circa-qualified years (`c. 1066`, `circa 1905`)
 *   - parenthesised year notations (`(1066)`)
 *
 * Does NOT drop entries with text alongside a year (`Order 66`,
 * `Apollo 11`, `Year of the Four Emperors`).
 */
export function isYearLike(term: string): boolean {
  let cleaned = term.trim();
  if (!cleaned) return false;
  cleaned = cleaned
    .replace(/^[\(\[\"'\u2018\u201c]+|[\)\]\"'\u2019\u201d]+$/g, "")
    .trim();
  cleaned = cleaned.replace(ERA_MARKER_RE, "").trim();
  cleaned = cleaned.replace(CIRCA_PREFIX_RE, "").trim();
  cleaned = cleaned.replace(YEAR_TRAILING_PUNCT, "").trim();
  if (!cleaned) return false;
  return YEAR_LIKE_REMAINDER_RE.test(cleaned);
}

/**
 * Returns a debug-level reason string when `term` should be dropped.
 * Used by both extractor parsers (source- and target-language) so a
 * sentence proposal, a runaway phrase, a broken-paren candidate, or
 * a raw year reference dies at the parser boundary.
 */
function violatesExtractorCaps(term: string): string | null {
  const cleaned = term.trim();
  if (!cleaned) return "empty after strip";
  if (cleaned.length > EXTRACTOR_MAX_CHARS) {
    return `length ${cleaned.length} > ${EXTRACTOR_MAX_CHARS} chars`;
  }
  const words = cleaned.split(/\s+/);
  if (words.length > EXTRACTOR_MAX_WORDS) {
    return `word count ${words.length} > ${EXTRACTOR_MAX_WORDS}`;
  }
  if (looksLikeSentence(cleaned)) {
    return "looks like a sentence (punctuation pattern)";
  }
  if (hasUnbalancedParens(cleaned)) return "unbalanced brackets";
  if (isYearLike(cleaned)) return "year-like (raw year, range, or decade)";
  return null;
}

const SYSTEM_PROMPT_TEMPLATE = `You are a literary entity extractor working alongside a translator on a
long-form story book. Your job is to read a chunk of source text in
\${source_lang} and return a structured list of recurring proper-noun
entities the translator will need to keep consistent in \${target_lang}.

What to surface:

* characters (named people / beings),
* places (cities, regions, buildings, named geography),
* organizations, factions, guilds, families,
* events (battles, festivals, ceremonies),
* items (named weapons, artifacts, vehicles, books),
* date_or_time markers (named eras, calendars, recurring holidays),
* recurring phrases, in-world terms, slang, epithets, idiomatic
  insults, or compound coinages that recur and must spell the same
  way every time. Hyphenated compounds (e.g. \`\`boot-lickers\`\`,
  \`\`half-elf\`\`, \`\`self-aware\`\`) and multi-word phrases
  (e.g. \`\`Council of Five\`\`) count — keep the hyphen / spaces in
  the \`\`source\`\` exactly as written,
* anything else worth keeping in the lore bible — use \`\`other\`\`.

Hard rules:

1. Only list entities that actually appear in the text I give you.
2. Skip entries that are already in the existing glossary below — they
   are settled. Do not propose synonyms or aliases of locked terms.
3. The \`\`source\`\` field must be the exact surface form as it appears
   in the source text — keep capitalization, hyphens, punctuation,
   and spacing. **It must be a noun phrase, named entity, or short
   fixed expression — at most 10 words and 100 characters. Never
   propose a full sentence, a clause with a verb chain, a
   description, or a quoted line of dialogue.** "Council of Five"
   is fine; "First you will eat your chickens, then your goats" is
   not — the second is a sentence and must not be proposed even
   if it recurs.
   **Never propose a raw year reference** (\`\`1066\`\`, \`\`1939-1945\`\`,
   \`\`1990s\`\`, \`\`c. 1066\`\`, \`\`45 BC\`\`) as an entity, even if it
   appears multiple times — the translator handles plain dates
   automatically and they only add noise to the lore bible.
   \`\`date_or_time\`\` is reserved for *named* eras, calendars, and
   recurring holidays (e.g. \`\`the Long Night\`\`, \`\`Yule\`\`,
   \`\`Founding Era\`\`). When a year is part of a longer phrase the
   phrase as a whole is fine (\`\`Year of the Four Emperors\`\`,
   \`\`Battle of 1066\`\`).
4. **When a name is commonly written \`\`Full Name (ACRONYM)\`\`** (e.g.
   \`\`Heavily Indebted Poor Country (HIPC)\`\`,
   \`\`Fédération Internationale de Football Association (FIFA)\`\`):
   use the ACRONYM as the canonical \`\`source\`\` (and \`\`target\`\`) and
   put the long form in \`\`aliases\`\` if the chunk shows it that way.
   Don't propose two separate entries for the long form and the
   acronym — they are the same entity.
5. The \`\`target\`\` field is your best-effort translation of the source
   term in \${target_lang} — apply the language's spelling and
   capitalization conventions (e.g. \`\`Julius Caesar\`\` → \`\`Júlio
   César\`\` in Brazilian Portuguese). Leave it as an empty string
   only when no idiomatic translation exists.
6. \`\`confidence\`\` is a number between 0.0 and 1.0; use 1.0 only when
   the text makes the entity unambiguous.
7. Best-effort narrative metadata: detect the dominant point-of-view
   (\`\`first\`\`, \`\`second\`\`, \`\`third_limited\`\`, \`\`third_omniscient\`\`, ...)
   and tense (\`\`past\`\`, \`\`present\`\`, ...) from the chunk. Leave them
   \`\`null\`\` if the chunk is too short or mixed.
8. Best-effort style observations for the curator (used to co-propose
   a tone preset): \`\`register\`\` is a short tag for the tone of the
   prose — pick from \`\`literary\`\`, \`\`genre\`\` (thriller / fantasy /
   SF / mystery), \`\`romance\`\`, \`\`explicit\`\` (sexually explicit /
   erotic), \`\`technical\`\` (manuals, how-to), \`\`academic\`\`,
   \`\`journalistic\`\`, or \`\`neutral\`\` — and \`\`audience\`\` is the
   intended reader: \`\`children\`\` (picture book / early reader),
   \`\`middle_grade\`\` (8-12), \`\`young_adult\`\` (teen), \`\`adult\`\`, or
   \`\`general\`\`. Leave both \`\`null\`\` when the chunk is too short or
   ambiguous to call.

\${glossary_block}Respond with a single JSON object and nothing else:

{
  "entities": [
    {"type": "character|place|organization|event|item|date_or_time|phrase|term|other",
     "source": "<surface form as in the text>",
     "target": "<best-effort translation in \${target_lang}, or empty string>",
     "evidence": "<short quote or paraphrase>",
     "confidence": 0.0}
  ],
  "pov": "first|third_limited|...|null",
  "tense": "past|present|...|null",
  "register": "literary|genre|romance|explicit|technical|academic|journalistic|neutral",
  "audience": "children|middle_grade|young_adult|adult|general",
  "notes": "optional free-text observations for the curator, or omit"
}

Do not wrap the JSON in code fences. Do not add commentary.`;

export interface BuildExtractorMessagesInput {
  source_lang: string;
  target_lang: string;
  source_text: string;
  glossary?: ReadonlyArray<GlossaryConstraint>;
}

export function buildExtractorMessages({
  source_lang,
  target_lang,
  source_text,
  glossary = [],
}: BuildExtractorMessagesInput): Message[] {
  if (!source_text || !source_text.trim()) {
    throw new Error("source_text must not be empty");
  }
  const block = formatGlossaryBlock(glossary);
  const system = SYSTEM_PROMPT_TEMPLATE.replace(/\$\{source_lang\}/g, source_lang)
    .replace(/\$\{target_lang\}/g, target_lang)
    .replace(/\$\{glossary_block\}/g, block);
  return [
    { role: "system", content: system },
    { role: "user", content: source_text },
  ];
}

function formatGlossaryBlock(
  glossary: ReadonlyArray<GlossaryConstraint>,
): string {
  if (!glossary.length) {
    return "Existing glossary: (empty — propose freely).\n\n";
  }
  const lines: string[] = ["Existing glossary (do not re-propose these):"];
  for (const entry of glossary) {
    if (entry.status === "proposed") continue;
    lines.push(
      `  - [${entry.type}] ${entry.source_term} → ${entry.target_term} (${entry.status})`,
    );
  }
  if (lines.length === 1) {
    return "Existing glossary: (empty — propose freely).\n\n";
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

const JSON_OBJECT_RE = /\{[\s\S]*\}/;

/**
 * Parse the helper LLM's JSON response (PRD §8.2 / F-LLM-3 fallback).
 *
 * Tries strict `JSON.parse` first; on failure attempts to recover the
 * first `{...}` block in the payload — this catches the common failure
 * mode where a permissive endpoint wraps JSON in prose despite the
 * system prompt's instructions. Anything that still doesn't parse
 * raises `LLMResponseError`.
 */
export function parseExtractorResponse(content: string): ExtractorTrace {
  if (!content || !content.trim()) {
    throw new LLMResponseError("extractor response was empty");
  }
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    const match = JSON_OBJECT_RE.exec(content);
    if (!match) {
      throw new LLMResponseError(
        "extractor response is not JSON and contains no JSON object",
      );
    }
    try {
      data = JSON.parse(match[0]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new LLMResponseError(
        `failed to recover JSON from extractor response: ${msg}`,
      );
    }
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new LLMResponseError(
      `extractor response top-level must be a JSON object; got ${typeof data}`,
    );
  }
  const obj = data as Record<string, unknown>;
  const entities_raw = obj.entities ?? [];
  if (!Array.isArray(entities_raw)) {
    throw new LLMResponseError("extractor response 'entities' must be a list");
  }

  const entities: ExtractedEntity[] = [];
  for (const raw of entities_raw) {
    const normalized = normalizeEntity(raw);
    if (normalized) entities.push(normalized);
  }

  return {
    entities,
    pov: coerceOptionalStr(obj.pov, "pov"),
    tense: coerceOptionalStr(obj.tense, "tense"),
    narrative_register: coerceOptionalStr(obj.register, "register"),
    narrative_audience: coerceOptionalStr(obj.audience, "audience"),
    notes: coerceOptionalStr(obj.notes, "notes"),
  };
}

function coerceOptionalStr(value: unknown, field_name: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new LLMResponseError(
      `extractor response '${field_name}' must be a string or null`,
    );
  }
  const cleaned = value.trim();
  return cleaned || null;
}

function normalizeEntity(raw: unknown): ExtractedEntity | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LLMResponseError("each entry in 'entities' must be a JSON object");
  }
  const r = raw as Record<string, unknown>;
  const source_raw = r.source ?? r.source_term;
  if (typeof source_raw !== "string") return null;
  const source = source_raw.trim();
  if (!source) return null;
  if (violatesExtractorCaps(source) !== null) return null;

  let type_str = String(r.type ?? "term").trim().toLowerCase();
  if (!type_str || !VALID_TYPES.has(type_str)) type_str = "term";

  const target_raw = r.target ?? r.target_term;
  let target: string | null;
  if (target_raw == null) {
    target = null;
  } else if (typeof target_raw === "string") {
    target = target_raw.trim() || null;
  } else {
    throw new LLMResponseError("entity 'target' must be a string or null");
  }
  if (target !== null && violatesExtractorCaps(target) !== null) {
    target = null;
  }

  let evidence: string | null;
  if (r.evidence == null) evidence = null;
  else if (typeof r.evidence === "string") evidence = r.evidence.trim() || null;
  else throw new LLMResponseError("entity 'evidence' must be a string or null");

  const conf_raw = r.confidence ?? 0.0;
  if (typeof conf_raw === "boolean") {
    throw new LLMResponseError("entity 'confidence' must be a number");
  }
  let confidence: number;
  if (typeof conf_raw === "number") {
    confidence = conf_raw;
  } else {
    const n = Number(conf_raw);
    if (Number.isNaN(n)) {
      throw new LLMResponseError("entity 'confidence' must be a number");
    }
    confidence = n;
  }
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    type: type_str as EntityTypeLiteral,
    source,
    target,
    evidence,
    confidence,
  };
}
