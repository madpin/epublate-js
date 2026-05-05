/**
 * Helper-LLM extractor prompt for *target-language* Lore Book ingest.
 *
 * Verbatim port of `epublate.llm.prompts.extractor_target` (PRD F-LB-3).
 *
 * The use case: a curator already owns a translated edition of a
 * series and wants to extract the canonical target spellings of every
 * recurring proper noun so the translator pipeline can use them as
 * soft-locked constraints when translating the *next* book in the
 * series.
 *
 * Unlike `extractor.ts`, the Lore Book here receives **target-only**
 * entities: the model never sees source text and never proposes a
 * source spelling.
 */

import { LLMResponseError } from "@/llm/base";
import type { Message, ResponseFormat } from "@/llm/base";
import type { GlossaryConstraint } from "@/llm/prompts/translator";

import {
  EXTRACTOR_MAX_CHARS,
  EXTRACTOR_MAX_WORDS,
  type EntityTypeLiteral,
} from "@/llm/prompts/extractor";

export const DEFAULT_TARGET_EXTRACTOR_RESPONSE_FORMAT: ResponseFormat = {
  type: "json_object",
};

export interface TargetExtractedEntity {
  type: EntityTypeLiteral;
  target: string;
  aliases: string[];
  evidence: string | null;
  confidence: number;
}

export interface TargetExtractorTrace {
  entities: TargetExtractedEntity[];
  notes: string | null;
}

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

const SENTENCE_PATTERN = /[.!?][\s"')\]]*$/;
const PARENS = /[(){}[\]]/g;
const YEAR_LIKE = /^(c\.\s*)?\d{1,4}(\s*(–|—|-|to)\s*\d{1,4})?(\s*(BC|AD|BCE|CE|s))?$/i;

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
  if (SENTENCE_PATTERN.test(cleaned) && words.length >= 4) {
    return "looks like a sentence (punctuation pattern)";
  }
  const matches = cleaned.match(PARENS) ?? [];
  let opens = 0;
  let closes = 0;
  for (const ch of matches) {
    if (ch === "(" || ch === "[" || ch === "{") opens += 1;
    else closes += 1;
  }
  if (opens !== closes) return "unbalanced brackets";
  if (YEAR_LIKE.test(cleaned)) return "year-like (raw year, range, or decade)";
  return null;
}

const SYSTEM_PROMPT_TEMPLATE = `You are a literary entity extractor working on a long-form story book
that has already been translated. Your job is to read a chunk of the
TARGET-language text in \${target_lang} and return a structured list of
the recurring proper-noun entities that appear in it. The translator
pipeline will reuse these canonical target spellings to keep future
translations of related books (e.g. other volumes in the same series)
consistent.

What to surface:

* characters (named people / beings),
* places (cities, regions, buildings, named geography),
* organizations, factions, guilds, families,
* events (battles, festivals, ceremonies),
* items (named weapons, artifacts, vehicles, books),
* date_or_time markers (named eras, calendars, recurring holidays),
* recurring phrases or in-world terms whose translation must stay
  identical across the series,
* anything else worth keeping in the lore book — use \`other\`.

Hard rules:

1. Every \`target\` field MUST be the exact spelling that appears in
   the chunk I give you (in \${target_lang}). Do not back-translate to
   \${source_lang}; the source spelling is unknown for this entry.
   **It must be a noun phrase, named entity, or short fixed
   expression — at most 10 words and 100 characters. Never propose a
   full sentence, a clause with a verb chain, a description, or a
   quoted line of dialogue** even if it recurs.
   **Never propose a raw year reference** (\`1066\`, \`1939-1945\`,
   \`1990s\`, \`c. 1066\`, \`45 BC\`) as an entity. \`date_or_time\`
   is reserved for *named* eras, calendars, and recurring holidays
   (\`the Long Night\`, \`Yule\`); plain years are inline date
   references the translator handles automatically.
2. **When a name is commonly written \`Full Name (ACRONYM)\`** (e.g.
   \`Federação Internacional de Futebol (FIFA)\`): use the ACRONYM
   as the canonical \`target\` and put the long form in \`aliases\`.
   Don't propose two separate entries for the long form and the
   acronym — they are the same entity.
3. Skip entries already present in the existing Lore Book glossary
   below — they are settled. Do not propose synonyms or aliases of
   \`locked\` terms.
4. \`aliases\` is an optional list of additional target-side spellings
   (nicknames, short forms, alternative transliterations) you observed
   in the chunk for the same entity. Each alias must respect the same
   length cap as \`target\`.
5. \`confidence\` is a number between 0.0 and 1.0; use 1.0 only when
   the chunk makes the entity unambiguous.

\${glossary_block}Respond with a single JSON object and nothing else:

{
  "entities": [
    {"type": "character|place|organization|event|item|date_or_time|phrase|term|other",
     "target": "<surface form as in the target text>",
     "aliases": ["<other target spelling>", ...],
     "evidence": "<short quote or paraphrase>",
     "confidence": 0.0}
  ],
  "notes": "optional free-text observations for the curator, or omit"
}

Do not wrap the JSON in code fences. Do not add commentary.`;

function formatGlossaryBlock(glossary: readonly GlossaryConstraint[]): string {
  if (!glossary.length) {
    return "Existing Lore Book glossary: (empty — propose freely).\n\n";
  }
  const lines = ["Existing Lore Book glossary (do not re-propose these):"];
  for (const entry of glossary) {
    if (entry.status === "proposed") continue;
    lines.push(`  - [${entry.type}] ${entry.target_term} (${entry.status})`);
  }
  if (lines.length === 1) {
    return "Existing Lore Book glossary: (empty — propose freely).\n\n";
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

export interface BuildTargetExtractorInput {
  target_lang: string;
  target_text: string;
  glossary?: readonly GlossaryConstraint[];
}

export function buildTargetExtractorMessages(
  input: BuildTargetExtractorInput,
): Message[] {
  const target_text = input.target_text;
  if (!target_text || !target_text.trim()) {
    throw new Error("target_text must not be empty");
  }
  const glossary_block = formatGlossaryBlock(input.glossary ?? []);
  const system_content = SYSTEM_PROMPT_TEMPLATE.replace(
    /\$\{target_lang\}/g,
    input.target_lang,
  )
    .replace(/\$\{source_lang\}/g, "the source language")
    .replace(/\$\{glossary_block\}/g, glossary_block);
  return [
    { role: "system", content: system_content },
    { role: "user", content: target_text },
  ];
}

const JSON_OBJECT_RE = /\{[\s\S]*\}/;

export function parseTargetExtractorResponse(
  content: string,
): TargetExtractorTrace {
  if (!content || !content.trim()) {
    throw new LLMResponseError("target extractor response was empty");
  }
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    const match = content.match(JSON_OBJECT_RE);
    if (!match) {
      throw new LLMResponseError(
        "target extractor response is not JSON and contains no JSON object",
      );
    }
    try {
      data = JSON.parse(match[0]);
    } catch (e) {
      throw new LLMResponseError(
        `failed to recover JSON from target extractor response: ${
          (e as Error).message
        }`,
      );
    }
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new LLMResponseError(
      `target extractor response top-level must be a JSON object; got ${
        Array.isArray(data) ? "array" : typeof data
      }`,
    );
  }

  const obj = data as Record<string, unknown>;
  const entities_raw = obj.entities ?? [];
  if (!Array.isArray(entities_raw)) {
    throw new LLMResponseError("target extractor 'entities' must be a list");
  }
  const entities: TargetExtractedEntity[] = [];
  for (const raw of entities_raw) {
    const normalized = normalizeEntity(raw);
    if (normalized !== null) entities.push(normalized);
  }

  const notes_raw = obj.notes;
  let notes: string | null = null;
  if (notes_raw === undefined || notes_raw === null) {
    notes = null;
  } else if (typeof notes_raw === "string") {
    notes = notes_raw.trim() || null;
  } else {
    throw new LLMResponseError("target extractor 'notes' must be a string");
  }

  return { entities, notes };
}

function normalizeEntity(raw: unknown): TargetExtractedEntity | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LLMResponseError("each entry in 'entities' must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const target_raw = obj.target ?? obj.target_term;
  if (typeof target_raw !== "string") return null;
  const target = target_raw.trim();
  if (!target) return null;
  if (violatesExtractorCaps(target) !== null) return null;

  const type_str = String(obj.type ?? "term").trim().toLowerCase() || "term";
  const type: EntityTypeLiteral = (
    VALID_TYPES.has(type_str) ? type_str : "term"
  ) as EntityTypeLiteral;

  const raw_aliases = obj.aliases;
  let aliases: string[] = [];
  if (raw_aliases === undefined || raw_aliases === null) {
    aliases = [];
  } else if (Array.isArray(raw_aliases)) {
    for (const item of raw_aliases) {
      if (typeof item !== "string") {
        throw new LLMResponseError(
          "entity 'aliases' must be a list of strings",
        );
      }
      const cleaned = item.trim();
      if (!cleaned || cleaned === target) continue;
      if (violatesExtractorCaps(cleaned) !== null) continue;
      aliases.push(cleaned);
    }
  } else {
    throw new LLMResponseError("entity 'aliases' must be a list of strings");
  }

  const evidence_raw = obj.evidence;
  let evidence: string | null = null;
  if (evidence_raw === undefined || evidence_raw === null) {
    evidence = null;
  } else if (typeof evidence_raw === "string") {
    evidence = evidence_raw.trim() || null;
  } else {
    throw new LLMResponseError("entity 'evidence' must be a string or null");
  }

  const confidence_raw = obj.confidence ?? 0.0;
  let confidence: number;
  if (typeof confidence_raw === "boolean") {
    throw new LLMResponseError("entity 'confidence' must be a number");
  } else if (typeof confidence_raw === "number") {
    confidence = confidence_raw;
  } else {
    throw new LLMResponseError("entity 'confidence' must be a number");
  }
  if (!Number.isFinite(confidence)) confidence = 0.0;
  confidence = Math.max(0.0, Math.min(1.0, confidence));

  return {
    type,
    target,
    aliases,
    evidence,
    confidence,
  };
}
