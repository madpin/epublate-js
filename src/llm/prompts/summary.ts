/**
 * Helper-LLM **summary** prompt builder + response parser.
 *
 * Two flows live here, mirroring the extractor module's shape:
 *
 *   - **Book summary** — drafts a 150-250 word premise from the
 *     opening segments of the book. Source-only (never the whole
 *     book) so the early-chapter translator prompts don't get
 *     spoiler-leaked. Output JSON: `{ summary, register, audience,
 *     notes }`.
 *   - **Chapter summary** — drafts a 50-120 word recap of one
 *     chapter, optionally seeded by an existing `book_summary` so
 *     the helper can keep cross-chapter continuity. Output JSON:
 *     `{ summary, pov_shift, scene_label }`.
 *
 * The module is pure: it turns project state into `Message` objects
 * and turns the model's response back into a typed trace. The
 * pipeline (`core/summary.ts`) owns the LLM call, the cache lookup,
 * and the DB writes.
 */

import { LLMResponseError } from "@/llm/base";
import type { Message, ResponseFormat } from "@/llm/base";
import type { GlossaryConstraint } from "@/llm/prompts/translator";

/**
 * Default `response_format` for summary prompts. We pin
 * `json_object` for the same reason the extractor does — reasoning
 * helpers can otherwise spend their visible-channel budget on
 * commentary and return empty content.
 */
export const DEFAULT_SUMMARY_RESPONSE_FORMAT: ResponseFormat = {
  type: "json_object",
};

/* ------------------------------------------------------------------ */
/* book summary                                                       */
/* ------------------------------------------------------------------ */

export interface BookSummaryTrace {
  /** 150-250 word premise. Must be non-empty. */
  summary: string;
  /** Optional helper-detected tone tag for cross-checking style. */
  register: string | null;
  /** Optional helper-detected audience tag. */
  audience: string | null;
  /** Optional free-text observations for the curator. */
  notes: string | null;
}

const BOOK_SYSTEM_PROMPT_TEMPLATE = `You are a literary editor working alongside a translator.
You will read the OPENING segments of a book in \${source_lang} and
draft a short premise the translator can lean on while translating
into \${target_lang}.

Keep the summary spoiler-light. The curator only fed you the first
chunk of the book on purpose — never speculate about events that have
not happened in the text I gave you. Stick to what is established
on the page.

What to capture:

* the premise of the story so far (setting, era, tone),
* the narrative voice (POV, register, register quirks),
* the most important named entities and their relationships,
* recurring stylistic choices the translator should preserve.

Hard rules:

1. The \`\`summary\`\` MUST be a single paragraph between 150 and 250
   words written in English. Do not include lists or bullets.
2. The summary is for a TRANSLATOR audience, not for the end reader.
   Skim the plot in plain prose; do not adopt the source's narrative
   voice.
3. \`\`register\`\` is a short tag for the tone of the prose — pick from
   \`\`literary\`\`, \`\`genre\`\`, \`\`romance\`\`, \`\`explicit\`\`,
   \`\`technical\`\`, \`\`academic\`\`, \`\`journalistic\`\`, or \`\`neutral\`\`.
   Use \`\`null\`\` when the chunk is too short to call.
4. \`\`audience\`\` is the intended reader: \`\`children\`\`,
   \`\`middle_grade\`\`, \`\`young_adult\`\`, \`\`adult\`\`, or
   \`\`general\`\`. Use \`\`null\`\` when ambiguous.
5. \`\`notes\`\` is OPTIONAL free-text for the curator (anything that
   doesn't belong in the summary itself, e.g. recurring imagery,
   suggested style adjustments). Use \`\`null\`\` when there is nothing
   to add.

\${glossary_block}Respond with a single JSON object and nothing else:

{
  "summary": "<150-250 word premise>",
  "register": "literary|genre|...|null",
  "audience": "adult|young_adult|...|null",
  "notes": "<optional free-text or null>"
}

Do not wrap the JSON in code fences. Do not add commentary.`;

export interface BuildBookSummaryMessagesInput {
  source_lang: string;
  target_lang: string;
  source_text: string;
  glossary?: ReadonlyArray<GlossaryConstraint>;
  /**
   * Optional existing summary to use as a seed when re-running. The
   * helper is told to refine, not to mirror, so this is a hint, not
   * a constraint.
   */
  prior_summary?: string | null;
}

export function buildBookSummaryMessages({
  source_lang,
  target_lang,
  source_text,
  glossary = [],
  prior_summary = null,
}: BuildBookSummaryMessagesInput): Message[] {
  if (!source_text || !source_text.trim()) {
    throw new Error("source_text must not be empty");
  }
  const block = formatGlossaryBlock(glossary);
  const system = BOOK_SYSTEM_PROMPT_TEMPLATE.replace(
    /\$\{source_lang\}/g,
    source_lang,
  )
    .replace(/\$\{target_lang\}/g, target_lang)
    .replace(/\$\{glossary_block\}/g, block);
  const seed = prior_summary?.trim();
  const user = seed
    ? `<prior_summary>\n${seed}\n</prior_summary>\n<source>\n${source_text}\n</source>`
    : `<source>\n${source_text}\n</source>`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function parseBookSummaryResponse(content: string): BookSummaryTrace {
  const data = parseJsonObject(content, "book summary");
  const summary = stringField(data, "summary");
  if (!summary) {
    throw new LLMResponseError("book summary `summary` field is missing or empty");
  }
  return {
    summary,
    register: optionalString(data, "register"),
    audience: optionalString(data, "audience"),
    notes: optionalString(data, "notes"),
  };
}

/* ------------------------------------------------------------------ */
/* chapter summary                                                    */
/* ------------------------------------------------------------------ */

export interface ChapterSummaryTrace {
  /** 50-120 word recap. Must be non-empty. */
  summary: string;
  /** Optional helper-detected POV shift relative to surrounding chapters. */
  pov_shift: string | null;
  /** Optional short scene label for the Reader (e.g. "courtroom"). */
  scene_label: string | null;
}

const CHAPTER_SYSTEM_PROMPT_TEMPLATE = `You are a literary editor working alongside a translator.
You will read ONE chapter of a book in \${source_lang} and write a
short recap the translator can lean on while translating into
\${target_lang}.

The curator may have given you a project-level book summary in the
\`\`<book_summary>\`\` block of the user message. Treat it as background
only — your job is to summarise the CHAPTER content in front of you.

What to capture:

* what happens in this chapter (plot beats, scene shifts),
* who's on stage and what relationships move,
* any tonal or POV change relative to the rest of the book.

Hard rules:

1. The \`\`summary\`\` MUST be a single paragraph between 50 and 120
   words written in English. No lists, no bullets, no headings.
2. The summary is for a TRANSLATOR audience, not for the end reader.
   Skim the plot in plain prose; do not adopt the source's narrative
   voice.
3. \`\`pov_shift\`\` is a short note when the chapter changes POV /
   tense / narrator relative to the surrounding context (e.g.
   \`\`shifts to first-person POV\`\`, \`\`flashback in past tense\`\`).
   Use \`\`null\`\` when it stays the same.
4. \`\`scene_label\`\` is OPTIONAL: a 1-3 word label for the dominant
   scene (e.g. \`\`courtroom\`\`, \`\`forest chase\`\`,
   \`\`family dinner\`\`). Use \`\`null\`\` when no single scene
   dominates.

\${glossary_block}Respond with a single JSON object and nothing else:

{
  "summary": "<50-120 word recap>",
  "pov_shift": "<short note or null>",
  "scene_label": "<1-3 word label or null>"
}

Do not wrap the JSON in code fences. Do not add commentary.`;

export interface BuildChapterSummaryMessagesInput {
  source_lang: string;
  target_lang: string;
  source_text: string;
  glossary?: ReadonlyArray<GlossaryConstraint>;
  /** Optional project-level book summary to seed the helper's context. */
  book_summary?: string | null;
  /** Optional chapter title for the helper's context. */
  chapter_title?: string | null;
}

export function buildChapterSummaryMessages({
  source_lang,
  target_lang,
  source_text,
  glossary = [],
  book_summary = null,
  chapter_title = null,
}: BuildChapterSummaryMessagesInput): Message[] {
  if (!source_text || !source_text.trim()) {
    throw new Error("source_text must not be empty");
  }
  const block = formatGlossaryBlock(glossary);
  const system = CHAPTER_SYSTEM_PROMPT_TEMPLATE.replace(
    /\$\{source_lang\}/g,
    source_lang,
  )
    .replace(/\$\{target_lang\}/g, target_lang)
    .replace(/\$\{glossary_block\}/g, block);
  const parts: string[] = [];
  if (book_summary && book_summary.trim()) {
    parts.push(`<book_summary>\n${book_summary.trim()}\n</book_summary>`);
  }
  if (chapter_title && chapter_title.trim()) {
    parts.push(`<chapter_title>${chapter_title.trim()}</chapter_title>`);
  }
  parts.push(`<source>\n${source_text}\n</source>`);
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n") },
  ];
}

export function parseChapterSummaryResponse(
  content: string,
): ChapterSummaryTrace {
  const data = parseJsonObject(content, "chapter summary");
  const summary = stringField(data, "summary");
  if (!summary) {
    throw new LLMResponseError(
      "chapter summary `summary` field is missing or empty",
    );
  }
  return {
    summary,
    pov_shift: optionalString(data, "pov_shift"),
    scene_label: optionalString(data, "scene_label"),
  };
}

/* ------------------------------------------------------------------ */
/* shared helpers                                                     */
/* ------------------------------------------------------------------ */

function formatGlossaryBlock(
  glossary: ReadonlyArray<GlossaryConstraint>,
): string {
  if (!glossary.length) {
    return "Existing glossary: (empty).\n\n";
  }
  const lines: string[] = ["Existing glossary (use these spellings):"];
  for (const entry of glossary) {
    if (entry.status === "proposed") continue;
    lines.push(
      `  - [${entry.type}] ${entry.source_term} → ${entry.target_term} (${entry.status})`,
    );
  }
  if (lines.length === 1) {
    return "Existing glossary: (empty).\n\n";
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

const JSON_OBJECT_RE = /\{[\s\S]*\}/;

function parseJsonObject(content: string, label: string): Record<string, unknown> {
  if (!content || !content.trim()) {
    throw new LLMResponseError(`${label} response was empty`);
  }
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    const match = JSON_OBJECT_RE.exec(content);
    if (!match) {
      throw new LLMResponseError(
        `${label} response is not JSON and contains no JSON object`,
      );
    }
    try {
      data = JSON.parse(match[0]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new LLMResponseError(
        `failed to recover JSON from ${label} response: ${msg}`,
      );
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new LLMResponseError(
      `${label} response root must be a JSON object, got ${typeof data}`,
    );
  }
  return data as Record<string, unknown>;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") return "";
  return v.trim();
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const v = obj[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}
