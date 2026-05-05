/**
 * Translator prompt builder + response parser
 * (mirrors `epublate.llm.prompts.translator`).
 *
 * Pure, side-effect-free functions: the pipeline owns the LLM call and
 * the DB write; this module only turns project state into `Message`
 * objects and turns the model's response back into a typed
 * `TranslatorTrace`.
 *
 * Inline tags never reach the model — `buildTranslatorMessages` assumes
 * the caller has already replaced them with `[[T0]]…[[/T0]]`
 * placeholders via `@/formats/epub/segmentation`.
 */

import { type Message, LLMResponseError } from "@/llm/base";

export type GlossaryStatus = "proposed" | "confirmed" | "locked";
export type GenderTag =
  | "feminine"
  | "masculine"
  | "neuter"
  | "common"
  | "unspecified";

export interface GlossaryConstraint {
  source_term: string;
  target_term: string;
  type?: string;
  status?: GlossaryStatus;
  notes?: string | null;
  gender?: GenderTag | null;
}

export interface TargetOnlyConstraint {
  target_term: string;
  type?: string;
  status?: GlossaryStatus;
  notes?: string | null;
  target_aliases?: readonly string[];
  gender?: GenderTag | null;
}

export interface ContextSegment {
  source_text: string;
  target_text: string | null;
  /** 1-based distance from the segment under translation. */
  segments_back: number;
}

export interface TranslatorTrace {
  target: string;
  used_entries: string[];
  new_entities: Array<Record<string, unknown>>;
  notes: string | null;
}

export interface GroupTranslatorItem {
  id: number;
  target: string;
  used_entries: string[];
  new_entities: Array<Record<string, unknown>>;
  notes: string | null;
}

export interface GroupTranslatorTrace {
  translations: GroupTranslatorItem[];
  notes: string | null;
}

const SYSTEM_PROMPT_TEMPLATE = `You are a literary translator working on a long ePub story book.

Translate the user's source segment from {source_lang} to {target_lang}.

Hard rules — these are not negotiable:

1. Inline formatting is encoded as opaque placeholders of the form
   \`[[T0]]\`, \`[[/T0]]\`, \`[[T1]]\`, etc. Every placeholder that appears in
   the source MUST appear exactly once in your translation, in the same
   relative order. Do not invent new placeholders. Do not drop any.
   Closing placeholders (\`[[/T0]]\`) must always pair with their opener
   (\`[[T0]]\`).
2. Translate naturally for the target audience but preserve narrative
   voice, tense, and POV. Do not paraphrase past the meaning of the
   source. Do not summarize. Render punctuation, contractions, and
   orthography according to target-language conventions —
   apostrophes, quotation mark style, dash usage, and similar
   typographic patterns are language-specific, so do NOT mechanically
   transcribe source-side punctuation that has no equivalent in the
   target. When this run's source/target pair has known pitfalls,
   they are listed under "Language-pair notes" below.
3. Translate every textual passage end-to-end. Embedded quotations
   (even when wrapped in placeholder pairs that mark italics or
   blockquote runs), bracketed asides like \`[sic]\` / \`[Emphasis
   added]\`, parenthetical clauses, footnote text, and book / article
   titles cited in the prose are all part of the segment and MUST be
   translated. Do not leave any chunk in the source language to
   "preserve the original quote" unless it is a code snippet or a
   proper name. If you would normally render a cited title as a
   parallel-text bilingual quote, instead translate it inline like
   the rest of the text and let the curator add a footnote later.
4. Preserve the leading and trailing whitespace of the source segment
   verbatim. If the source begins with newlines and indentation
   (e.g. \`"\\n    [[T0]]…"\`) your target MUST begin with the same
   characters; same for trailing whitespace. Do not strip, collapse,
   or "tidy" the surrounding whitespace.
5. Keep proper nouns, place names, and domain terms consistent across
   the book. The glossary below lists agreed translations.
6. Locked glossary entries are non-negotiable. Confirmed entries are
   strong defaults. Proposed entries are suggestions.
7. Apply a glossary entry only when the source term is used in the
   same sense as the entry. Some entries map a common noun to a
   specialized translation (e.g. \`House\` → \`Câmara\` for a
   parliamentary chamber) — when the source uses the same word in an
   ordinary, unrelated sense (a building, a family, …), translate
   it idiomatically and ignore the entry. The notes column on each
   entry, when present, hints at the intended sense.
8. When a glossary entry carries a \`(gender: …)\` marker the
   canonical target term has that grammatical gender. Surrounding
   articles, demonstratives, possessives, adjectives, and past
   participles MUST agree with that gender, including any preposition
   contractions (e.g. \`a Câmara\` / \`da Câmara\` for feminine,
   \`o Senhor\` / \`do Senhor\` for masculine).
   When the source uses an article with a glossary term, your
   translation MUST keep the article and inflect it correctly.
9. Glossary entries are recorded in a balanced shape: either both
   the source term and the target term carry a leading article /
   preposition (e.g. \`the USA → os EUA\`), or neither does
   (\`Europe → Europa\`, \`USA → EUA\`). When the entry has NO
   leading article, you MUST inflect the surrounding article /
   preposition / contraction yourself based on the source: render
   \`"in Europe"\` as \`"na Europa"\`, \`"the Senate voted"\` as
   \`"o Senado votou"\`, etc. — and never emit doubled function
   words like \`"na na Europa"\` or \`"the the Senate"\`. When the
   entry HAS a leading article on both sides, treat the article as
   part of the canonical spelling and do not add another one.

{language_notes_block}{style_guide_block}{chapter_notes_block}{glossary_block}{target_only_block}{context_block}Respond with a single JSON object and nothing else:

{
  "target": "<translated text with placeholders preserved>",
  "used_entries": ["<source_term you used a glossary entry for>", ...],
  "new_entities": [
    {"type": "character|place|...",
     "source": "<surface form in the source>",
     "target": "<the exact target spelling you used in the translation above>",
     "evidence": "..."},
    ...
  ],
  "notes": "optional free-text notes for the curator, or omit"
}

When you list a candidate in \`new_entities\` its \`target\` MUST be
the literal spelling you used inside \`target\` for this segment —
that's how the lore bible learns the canonical translation. If for
some reason the entity does not appear in the translation (e.g. you
elided it), set \`target\` to the form you would use next time.

Do NOT propose raw year references (\`1066\`, \`1939-1945\`,
\`1990s\`, \`c. 1066\`, \`45 BC\`) in \`new_entities\`. Plain dates
are handled inline by the translation; the lore bible only tracks
*named* eras and recurring holidays (\`the Long Night\`, \`Yule\`).
When a year is part of a longer named phrase the phrase as a whole
is fine (\`Year of the Four Emperors\`, \`Battle of 1066\`).

Do not wrap the JSON in code fences. Do not add commentary.`;

const GROUP_SYSTEM_PROMPT_TEMPLATE = `You are a literary translator working on a long ePub story book.

The user is sending a BATCH of short, independent segments (typically
items from a table of contents, glossary, list, index, or other
repetitive structure) so you can translate them in a single round-trip.
Translate each segment from {source_lang} to {target_lang}.

Hard rules — these are not negotiable:

1. Preserve the number and order of items. Your response's
   \`translations\` array must contain exactly one entry per input
   item, with the same \`id\` values — do not merge, drop, or invent
   items.
2. Keep each translation scoped to its own item. Do NOT bleed context
   from one item into the next.
3. Translate naturally for the target audience; do not paraphrase past
   the meaning of the source and do not summarize. Render punctuation,
   contractions, and orthography according to target-language
   conventions — apostrophes, quotation mark style, dash usage, and
   similar typographic patterns are language-specific, so do NOT
   mechanically transcribe source-side punctuation that has no
   equivalent in the target. When this run's source/target pair has
   known pitfalls, they are listed under "Language-pair notes" below.
4. Translate every textual passage end-to-end. Embedded quotations,
   bracketed asides, parenthetical clauses, footnote text, and
   book / article titles cited inside an item are all part of that
   item and MUST be translated. Do not leave any chunk in the source
   language to "preserve the original quote" unless it is a code
   snippet or a proper name.
5. Preserve the leading and trailing whitespace of each source item
   verbatim in the matching target. Do not strip, collapse, or
   "tidy" surrounding whitespace.
6. Keep proper nouns, place names, and domain terms consistent with
   the glossary below. Locked glossary entries are non-negotiable,
   confirmed entries are strong defaults, proposed entries are
   suggestions.
7. Apply a glossary entry only when the source term is used in the
   same sense as the entry. When the source uses the same word in an
   ordinary, unrelated sense, translate it idiomatically and ignore
   the entry. The notes column on each entry, when present, hints at
   the intended sense.
8. When a glossary entry carries a \`(gender: …)\` marker the
   canonical target term has that grammatical gender. Surrounding
   articles, demonstratives, possessives, adjectives, and past
   participles MUST agree with that gender, including any preposition
   contractions. When the source uses an article with a glossary
   term, your translation MUST keep the article and inflect it
   correctly.
9. Glossary entries are recorded in a balanced shape: either both
   the source term and the target term carry a leading article /
   preposition (\`the USA → os EUA\`), or neither does
   (\`Europe → Europa\`). When the entry has NO leading article,
   inflect the surrounding article / preposition / contraction
   yourself based on the source ("in Europe" → "na Europa", "the
   Senate voted" → "o Senado votou") and never emit doubled
   function words like \`"na na Europa"\` or \`"the the Senate"\`.
   When the entry HAS a leading article on both sides, treat the
   article as part of the canonical spelling and do not add another
   one.
10. Inline formatting in each item's source is encoded as opaque
    placeholders of the form \`[[T0]]\`, \`[[/T0]]\`, \`[[T1]]\`, etc.
    For each item, every placeholder that appears in that item's
    source MUST appear exactly once in that item's target, in the same
    relative order. Do not invent new placeholders. Do not drop any.
    Closing placeholders (\`[[/T0]]\`) must always pair with their
    opener (\`[[T0]]\`). Placeholder ids are local to each item — do
    not share or shift them across items.

{language_notes_block}{style_guide_block}{glossary_block}{target_only_block}Input format: the user message is a JSON object of the shape
\`{"items": [{"id": 1, "source": "..."}, ...]}\`. Respond with a
single JSON object and nothing else:

{
  "translations": [
    {
      "id": <the item id you were given>,
      "target": "<translated text with placeholders preserved>",
      "used_entries": ["<source_term you applied from the glossary>", ...],
      "new_entities": [
        {"type": "character|place|...",
         "source": "<surface form in the source>",
         "target": "<the exact target spelling you used above>",
         "evidence": "..."},
        ...
      ],
      "notes": "optional, omit when empty"
    },
    ...
  ],
  "notes": "optional batch-level note, omit when empty"
}

Do NOT propose raw year references (\`1066\`, \`1939-1945\`,
\`1990s\`, \`c. 1066\`, \`45 BC\`) in \`new_entities\`. Plain dates
are handled inline by the translation; the lore bible only tracks
*named* eras and recurring holidays.

Do not wrap the JSON in code fences. Do not add commentary.`;

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  "en-us": "American English",
  "en-gb": "British English",
  "en-au": "Australian English",
  "en-ca": "Canadian English",
  fr: "French",
  "fr-fr": "French (France)",
  "fr-ca": "Canadian French",
  "fr-be": "Belgian French",
  "fr-ch": "Swiss French",
  es: "Spanish",
  "es-es": "European Spanish",
  "es-mx": "Mexican Spanish",
  "es-ar": "Argentine Spanish",
  "es-co": "Colombian Spanish",
  "es-419": "Latin American Spanish",
  pt: "Portuguese",
  "pt-pt": "European Portuguese",
  "pt-br": "Brazilian Portuguese",
  it: "Italian",
  "it-it": "Italian",
  de: "German",
  "de-de": "German",
  "de-at": "Austrian German",
  "de-ch": "Swiss German",
  nl: "Dutch",
  "nl-nl": "Dutch",
  "nl-be": "Flemish",
  ca: "Catalan",
  gl: "Galician",
  eu: "Basque",
  no: "Norwegian",
  nb: "Norwegian Bokmål",
  nn: "Norwegian Nynorsk",
  sv: "Swedish",
  da: "Danish",
  fi: "Finnish",
  is: "Icelandic",
  et: "Estonian",
  lv: "Latvian",
  lt: "Lithuanian",
  ru: "Russian",
  uk: "Ukrainian",
  be: "Belarusian",
  pl: "Polish",
  cs: "Czech",
  sk: "Slovak",
  hu: "Hungarian",
  ro: "Romanian",
  bg: "Bulgarian",
  hr: "Croatian",
  sr: "Serbian",
  "sr-latn": "Serbian (Latin)",
  "sr-cyrl": "Serbian (Cyrillic)",
  sl: "Slovenian",
  mk: "Macedonian",
  sq: "Albanian",
  el: "Greek",
  ar: "Arabic",
  "ar-eg": "Egyptian Arabic",
  "ar-sa": "Saudi Arabic",
  "ar-lb": "Lebanese Arabic",
  he: "Hebrew",
  fa: "Persian",
  ur: "Urdu",
  ps: "Pashto",
  ku: "Kurdish",
  tr: "Turkish",
  az: "Azerbaijani",
  hy: "Armenian",
  ka: "Georgian",
  hi: "Hindi",
  bn: "Bengali",
  pa: "Punjabi",
  gu: "Gujarati",
  mr: "Marathi",
  ta: "Tamil",
  te: "Telugu",
  kn: "Kannada",
  ml: "Malayalam",
  si: "Sinhala",
  ne: "Nepali",
  zh: "Chinese",
  "zh-cn": "Simplified Chinese",
  "zh-tw": "Traditional Chinese",
  "zh-hans": "Simplified Chinese",
  "zh-hant": "Traditional Chinese",
  "zh-hk": "Hong Kong Chinese",
  ja: "Japanese",
  ko: "Korean",
  mn: "Mongolian",
  id: "Indonesian",
  ms: "Malay",
  vi: "Vietnamese",
  th: "Thai",
  lo: "Lao",
  km: "Khmer",
  my: "Burmese",
  tl: "Tagalog",
  fil: "Filipino",
  sw: "Swahili",
  am: "Amharic",
  yo: "Yoruba",
  ha: "Hausa",
  ig: "Igbo",
  zu: "Zulu",
  xh: "Xhosa",
  af: "Afrikaans",
  la: "Latin",
  eo: "Esperanto",
};

function formatLanguageLabel(lang: string): string {
  if (!lang) return lang;
  const raw = lang.trim();
  if (!raw) return raw;
  const key = raw.toLowerCase();
  let name = LANGUAGE_NAMES[key];
  if (name == null) {
    const primary = key.split("-", 1)[0];
    if (primary !== key) name = LANGUAGE_NAMES[primary];
  }
  return name == null ? raw : `${name} (${raw})`;
}

const SOURCE_LANG_NOTES: Record<string, string> = {
  fr:
    "French uses apostrophe contractions for elision " +
    "(``j'avais``, ``s'appelait``, ``l'arbre``, ``qu'il``, " +
    "``d'avoir``, ``n'est``). The apostrophe is part of French " +
    "orthography ONLY — when the target language does not use " +
    "the same convention, the apostrophe MUST be removed entirely " +
    "(NOT moved, NOT preserved as a leading character on the " +
    "next word). Translate the elided forms into their full " +
    "target-language equivalents:\n" +
    "  - ``j'avais`` → ``eu tinha`` (NOT ``eu'tinha``, NOT " +
    "``eu 'tinha``).\n" +
    "  - ``J'ai une excuse.`` → ``Tenho uma desculpa.`` (NOT " +
    "``Eu 'tenho uma desculpa.``).\n" +
    "  - ``s'appelait`` → ``se chamava`` (NOT ``'se chamava``).\n" +
    "  - ``d'avoir dédié`` → ``por ter dedicado`` (NOT ``por " +
    "'ter dedicado``).\n" +
    "  - ``l'enfant qu'a été`` → ``a criança que foi`` (NOT " +
    "``à 'criança que 'foi``).",
  it:
    "Italian uses apostrophe contractions for elision (``l'amico``, " +
    "``dell'amore``, ``un'idea``). Carry the apostrophe over only " +
    "when the target language uses the same convention; otherwise " +
    "render the full target-language form.",
  de:
    "German capitalizes every common noun. Do NOT preserve those " +
    "capitals in the target unless the target language also " +
    "capitalizes nouns; render proper-noun capitalization " +
    "according to target-language rules.",
  es:
    "Spanish opens questions and exclamations with ``¿`` / ``¡``. " +
    "Most other languages only use the closing mark, so translate " +
    "the punctuation to whatever the target language conventionally " +
    "uses for questions and exclamations.",
};

const TARGET_LANG_NOTES: Record<string, string> = {
  pt:
    "Portuguese does NOT use apostrophe contractions in modern " +
    "prose: write ``eu tinha``, ``se chamava``, ``ele era`` as " +
    "two separate words with a normal space between them. " +
    "Preposition + article contractions use dedicated glyphs " +
    "(``de + a = da``, ``em + o = no``, ``por + a = pela``), " +
    "never an apostrophe. NEVER write an apostrophe directly " +
    "in front of a Portuguese word — leading apostrophes " +
    "(``'tenho``, ``'ser``, ``'criança``) are ALWAYS wrong, " +
    "even when carrying the pattern over from a French / " +
    "Italian / Catalan source that elides verbs with " +
    "apostrophes. Dialogue is conventionally introduced with " +
    "an em-dash (``— Olá!``). Quotation marks, when used, are " +
    "guillemets ``«…»`` or curly doubles ``\u201C\u2026\u201D``.",
  en:
    "English uses apostrophes for contractions (``don't``, " +
    "``it's``) and possessives (``Mary's``). Quotation marks are " +
    'typically straight ``"…"`` or curly ``"…"``; guillemets ' +
    "``«…»`` read as foreign and should be replaced unless the " +
    "source-language flavor is deliberately preserved.",
  fr:
    "French uses apostrophe contractions for elision " +
    "(``j'avais``, ``l'arbre``). Quotation marks are conventionally " +
    "guillemets ``« … »`` with thin spaces inside; double straight " +
    "quotes are anglicisms in French prose.",
  es:
    "Spanish opens questions and exclamations with ``¿`` / ``¡`` " +
    "and closes them with ``?`` / ``!``. Dialogue is conventionally " +
    "introduced with an em-dash (``— Hola``).",
  it:
    "Italian uses apostrophe contractions for elision (``l'amico``, " +
    "``dell'amore``). Quotation marks are conventionally guillemets " +
    "``« … »``; double straight quotes read as anglicisms.",
};

function lookupLangNote(
  lang: string,
  table: Record<string, string>,
): string | null {
  if (!lang) return null;
  const full = lang.trim().toLowerCase();
  if (table[full]) return table[full];
  const primary = full.split("-", 1)[0];
  if (primary !== full && table[primary]) return table[primary];
  return null;
}

function formatLanguagePairNotes(
  source_lang: string,
  target_lang: string,
): string {
  const src = lookupLangNote(source_lang, SOURCE_LANG_NOTES);
  const tgt = lookupLangNote(target_lang, TARGET_LANG_NOTES);
  if (!src && !tgt) return "";
  const lines: string[] = [`Language-pair notes (${source_lang} → ${target_lang}):`];
  if (src) lines.push(`  - When translating FROM ${source_lang}: ${src}`);
  if (tgt) lines.push(`  - When translating TO ${target_lang}: ${tgt}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatGlossaryBlock(glossary: readonly GlossaryConstraint[]): string {
  if (!glossary.length) return "Glossary: (empty for this segment).\n\n";
  const buckets: Record<GlossaryStatus, GlossaryConstraint[]> = {
    locked: [],
    confirmed: [],
    proposed: [],
  };
  for (const entry of glossary) {
    const s = (entry.status ?? "confirmed") as GlossaryStatus;
    buckets[s] = buckets[s] ?? [];
    buckets[s].push(entry);
  }
  const lines: string[] = ["Glossary:"];
  for (const status of ["locked", "confirmed", "proposed"] as const) {
    const bucket = buckets[status];
    if (!bucket.length) continue;
    lines.push(`  ${status} entries (must use the canonical target term):`);
    for (const entry of bucket) {
      const gender_marker =
        entry.gender && entry.gender !== "unspecified"
          ? ` (gender: ${entry.gender})`
          : "";
      const note = entry.notes ? ` — ${entry.notes}` : "";
      const type = entry.type ?? "term";
      lines.push(
        `    - [${type}] ${entry.source_term} → ${entry.target_term}${gender_marker}${note}`,
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatTargetOnlyBlock(
  glossary: readonly TargetOnlyConstraint[],
): string {
  if (!glossary.length) return "";
  const buckets: Record<GlossaryStatus, TargetOnlyConstraint[]> = {
    locked: [],
    confirmed: [],
    proposed: [],
  };
  for (const entry of glossary) {
    const s = (entry.status ?? "confirmed") as GlossaryStatus;
    buckets[s] = buckets[s] ?? [];
    buckets[s].push(entry);
  }
  const lines: string[] = [
    "Canonical target terms used in this work (no source spelling on file):",
  ];
  let has_any = false;
  for (const status of ["locked", "confirmed"] as const) {
    const bucket = buckets[status];
    if (!bucket.length) continue;
    has_any = true;
    lines.push(
      `  ${status} target forms (use the canonical spelling when applicable):`,
    );
    for (const entry of bucket) {
      const aliases =
        entry.target_aliases && entry.target_aliases.length > 0
          ? `  (aliases: ${entry.target_aliases.join(", ")})`
          : "";
      const gender_marker =
        entry.gender && entry.gender !== "unspecified"
          ? ` (gender: ${entry.gender})`
          : "";
      const note = entry.notes ? ` — ${entry.notes}` : "";
      const type = entry.type ?? "term";
      lines.push(
        `    - [${type}] ${entry.target_term}${gender_marker}${aliases}${note}`,
      );
    }
  }
  if (!has_any) return "";
  lines.push("");
  lines.push(
    "If you encounter a source-language term in this segment that names " +
      "one of the entities above, you MUST translate it using the canonical " +
      "target form. If no source term in this segment maps to one of these " +
      "entities, ignore this list entirely.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatContextBlock(context: readonly ContextSegment[]): string {
  if (!context.length) return "";
  const ordered = [...context].sort((a, b) => b.segments_back - a.segments_back);
  const lines: string[] = [
    "Preceding segments (context only — DO NOT translate them; " +
      "translate ONLY the user's segment below):",
  ];
  for (const entry of ordered) {
    const src = entry.source_text.trim() || "(empty)";
    const tgt = entry.target_text?.trim() || "(not yet translated)";
    lines.push(`  - source: ${src}`);
    lines.push(`    target: ${tgt}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export interface BuildTranslatorMessagesInput {
  source_lang: string;
  target_lang: string;
  source_text: string;
  style_guide?: string | null;
  /**
   * Curator-authored chapter notes, injected verbatim ahead of the
   * glossary block. Use this for POV switches, recurring imagery, or
   * scene-level disambiguations that the model can't infer from the
   * segment alone. Trimmed to keep stale whitespace out of the cache
   * key.
   */
  chapter_notes?: string | null;
  glossary?: readonly GlossaryConstraint[];
  target_only_glossary?: readonly TargetOnlyConstraint[];
  context?: readonly ContextSegment[];
}

export function buildTranslatorMessages(
  input: BuildTranslatorMessagesInput,
): Message[] {
  if (!input.source_text) {
    throw new Error("source_text must not be empty");
  }
  const style_guide_block = input.style_guide?.trim()
    ? `Style guide:\n${input.style_guide.trim()}\n\n`
    : "";
  const chapter_notes_block = input.chapter_notes?.trim()
    ? `Chapter notes (context for this whole chapter — do not translate them):\n${input.chapter_notes.trim()}\n\n`
    : "";
  const glossary_block = formatGlossaryBlock(input.glossary ?? []);
  const target_only_block = formatTargetOnlyBlock(
    input.target_only_glossary ?? [],
  );
  const language_notes_block = formatLanguagePairNotes(
    input.source_lang,
    input.target_lang,
  );
  const context_block = formatContextBlock(input.context ?? []);

  const system_content = SYSTEM_PROMPT_TEMPLATE.replace(
    "{source_lang}",
    formatLanguageLabel(input.source_lang),
  )
    .replace("{target_lang}", formatLanguageLabel(input.target_lang))
    .replace("{style_guide_block}", style_guide_block)
    .replace("{chapter_notes_block}", chapter_notes_block)
    .replace("{glossary_block}", glossary_block)
    .replace("{target_only_block}", target_only_block)
    .replace("{language_notes_block}", language_notes_block)
    .replace("{context_block}", context_block);

  return [
    { role: "system", content: system_content },
    { role: "user", content: input.source_text },
  ];
}

export interface BuildGroupTranslatorMessagesInput {
  source_lang: string;
  target_lang: string;
  source_items: ReadonlyArray<readonly [number, string]>;
  style_guide?: string | null;
  glossary?: readonly GlossaryConstraint[];
  target_only_glossary?: readonly TargetOnlyConstraint[];
}

export function buildGroupTranslatorMessages(
  input: BuildGroupTranslatorMessagesInput,
): Message[] {
  if (!input.source_items.length) {
    throw new Error("source_items must not be empty");
  }
  const seen = new Set<number>();
  for (const [item_id, text] of input.source_items) {
    if (seen.has(item_id)) {
      throw new Error(`duplicate item id ${item_id} in source_items`);
    }
    if (!text) {
      throw new Error(`source_items[${item_id}] has empty source_text`);
    }
    seen.add(item_id);
  }

  const style_guide_block = input.style_guide?.trim()
    ? `Style guide:\n${input.style_guide.trim()}\n\n`
    : "";
  const glossary_block = formatGlossaryBlock(input.glossary ?? []);
  const target_only_block = formatTargetOnlyBlock(
    input.target_only_glossary ?? [],
  );
  const language_notes_block = formatLanguagePairNotes(
    input.source_lang,
    input.target_lang,
  );

  const system_content = GROUP_SYSTEM_PROMPT_TEMPLATE.replace(
    "{source_lang}",
    formatLanguageLabel(input.source_lang),
  )
    .replace("{target_lang}", formatLanguageLabel(input.target_lang))
    .replace("{style_guide_block}", style_guide_block)
    .replace("{glossary_block}", glossary_block)
    .replace("{target_only_block}", target_only_block)
    .replace("{language_notes_block}", language_notes_block);

  const user_payload = {
    items: input.source_items.map(([id, source]) => ({ id, source })),
  };
  return [
    { role: "system", content: system_content },
    { role: "user", content: JSON.stringify(user_payload) },
  ];
}

const JSON_OBJECT_RE = /\{[\s\S]*\}/;

function safeJsonParse(content: string, label: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(JSON_OBJECT_RE);
    if (!match) {
      throw new LLMResponseError(
        `${label} response is not JSON and contains no JSON object`,
      );
    }
    try {
      return JSON.parse(match[0]);
    } catch (exc: unknown) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      throw new LLMResponseError(
        `failed to recover JSON from ${label} response: ${msg}`,
      );
    }
  }
}

export function parseTranslatorResponse(content: string): TranslatorTrace {
  if (!content || !content.trim()) {
    throw new LLMResponseError("translator response was empty");
  }
  const data = safeJsonParse(content, "translator");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new LLMResponseError(
      "translator response top-level must be a JSON object",
    );
  }
  const obj = data as Record<string, unknown>;
  if (!("target" in obj)) {
    throw new LLMResponseError("translator response missing required 'target' field");
  }
  const target = obj.target;
  if (typeof target !== "string") {
    throw new LLMResponseError("translator response 'target' must be a string");
  }
  const used_entries_raw = obj.used_entries ?? [];
  if (!Array.isArray(used_entries_raw)) {
    throw new LLMResponseError("translator response 'used_entries' must be a list");
  }
  const used_entries = used_entries_raw.map((x) => String(x));

  const new_entities_raw = obj.new_entities ?? [];
  if (!Array.isArray(new_entities_raw)) {
    throw new LLMResponseError("translator response 'new_entities' must be a list");
  }
  const new_entities: Array<Record<string, unknown>> = [];
  for (const item of new_entities_raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new LLMResponseError(
        "each entry in 'new_entities' must be a JSON object",
      );
    }
    new_entities.push({ ...(item as Record<string, unknown>) });
  }

  const notes_raw = obj.notes;
  if (notes_raw != null && typeof notes_raw !== "string") {
    throw new LLMResponseError(
      "translator response 'notes' must be a string if set",
    );
  }
  return {
    target,
    used_entries,
    new_entities,
    notes: typeof notes_raw === "string" ? notes_raw : null,
  };
}

export function parseGroupTranslatorResponse(
  content: string,
  options: { expected_ids?: readonly number[] } = {},
): GroupTranslatorTrace {
  if (!content || !content.trim()) {
    throw new LLMResponseError("group translator response was empty");
  }
  const data = safeJsonParse(content, "group translator");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new LLMResponseError(
      "group translator response top-level must be a JSON object",
    );
  }
  const obj = data as Record<string, unknown>;
  const translations_raw = obj.translations;
  if (!Array.isArray(translations_raw)) {
    throw new LLMResponseError(
      "group translator response missing 'translations' list",
    );
  }
  const items: GroupTranslatorItem[] = [];
  const seen_ids = new Set<number>();
  for (const raw of translations_raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new LLMResponseError(
        "each 'translations' entry must be a JSON object",
      );
    }
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "number" ? r.id : Number(r.id);
    if (!Number.isFinite(id)) {
      throw new LLMResponseError("translation entry missing numeric 'id'");
    }
    if (seen_ids.has(id)) {
      throw new LLMResponseError(
        `duplicate item id ${id} in group translator response`,
      );
    }
    seen_ids.add(id);
    if (typeof r.target !== "string") {
      throw new LLMResponseError("translation entry 'target' must be a string");
    }
    const used_entries_raw = r.used_entries ?? [];
    if (!Array.isArray(used_entries_raw)) {
      throw new LLMResponseError(
        "translation entry 'used_entries' must be a list",
      );
    }
    const new_entities_raw = r.new_entities ?? [];
    if (!Array.isArray(new_entities_raw)) {
      throw new LLMResponseError(
        "translation entry 'new_entities' must be a list",
      );
    }
    const notes_raw = r.notes;
    if (notes_raw != null && typeof notes_raw !== "string") {
      throw new LLMResponseError(
        "translation entry 'notes' must be a string if set",
      );
    }
    items.push({
      id,
      target: r.target,
      used_entries: used_entries_raw.map((x) => String(x)),
      new_entities: new_entities_raw.map((x) =>
        x && typeof x === "object" && !Array.isArray(x)
          ? { ...(x as Record<string, unknown>) }
          : (() => {
              throw new LLMResponseError(
                "each new_entities entry must be a JSON object",
              );
            })(),
      ),
      notes: typeof notes_raw === "string" ? notes_raw : null,
    });
  }
  if (options.expected_ids) {
    const missing = options.expected_ids.filter((i) => !seen_ids.has(i));
    if (missing.length) {
      throw new LLMResponseError(
        `group translator response missing ids: ${JSON.stringify(missing)}`,
      );
    }
  }
  const top_notes = obj.notes;
  if (top_notes != null && typeof top_notes !== "string") {
    throw new LLMResponseError(
      "group translator response 'notes' must be a string",
    );
  }
  return {
    translations: items,
    notes: typeof top_notes === "string" ? top_notes : null,
  };
}
