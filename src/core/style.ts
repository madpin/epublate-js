/**
 * Tone / style profile registry — port of `epublate.core.style`.
 *
 * The translator's system prompt always carries a free-form
 * `style_guide` string. Authoring it from scratch every time is a bad
 * UX, so this module ships the same catalog of named **style profiles**
 * the Python tool ships (verbatim prompt blocks). Each profile expands
 * to a paragraph the LLM can act on directly.
 *
 * Two ways the curator's choice lands in the project:
 *
 * - {@link resolveStyleGuide} turns a `(profile_id, custom_text)` pair
 *   into the actual prompt block we persist on `project.style_guide`.
 *   Custom text wins over the preset.
 * - {@link DEFAULT_STYLE_PROFILE} is the safe fallback we plant on
 *   freshly created projects so translations don't drift into a sterile,
 *   register-neutral default.
 *
 * The helper LLM extractor returns a best-effort `(register, audience)`
 * observation about the book; {@link suggestStyleProfile} maps that
 * pair to a preset id so the dashboard can surface
 * "Helper suggests: YA fantasy" right after intake.
 *
 * Cache discipline: the profile's `prompt_block` is what lives in
 * `project.style_guide`, which is part of the translator's system
 * prompt hash — so changing a profile correctly invalidates cached
 * translations.
 */

export const DEFAULT_STYLE_PROFILE = "literary_fiction";

export interface StyleProfile {
  /** Machine-readable slug we persist. */
  id: string;
  /** Short label the Select widget shows. */
  name: string;
  /** One-liner for dashboard / settings panel. */
  description: string;
  /** Paragraph the translator's system prompt embeds. */
  prompt_block: string;
}

function normalize(text: string): string {
  const lines = text.trim().split(/\r?\n/).map((l) => l.trim());
  const out: string[] = [];
  for (const line of lines) {
    if (line === "") {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

const PROFILES: readonly StyleProfile[] = [
  {
    id: "literary_fiction",
    name: "Literary fiction",
    description:
      "Adult literary register. Preserves narrative voice and subtext. Safe default for unknown books.",
    prompt_block: normalize(`
      Translate as adult literary fiction. Preserve the narrator's
      voice, sentence rhythm, and subtext; do not flatten metaphors
      into literal meaning. Mirror the source's register from
      paragraph to paragraph rather than imposing a uniform formal
      tone — when the source shifts (dialogue vs. exposition,
      character thought vs. action), let the translation shift with
      it. Keep contractions and colloquialisms when the source uses
      them; keep formal or archaic phrasing when it doesn't.
    `),
  },
  {
    id: "classic_literature",
    name: "Classic literature (19th - early 20th c.)",
    description:
      "Nineteenth to early twentieth century register. Long articulated sentences, formal diction, omniscient voice.",
    prompt_block: normalize(`
      Translate as classic nineteenth- to early-twentieth-century
      literature. Sentences are long and articulated, with
      parenthetical asides and a confident omniscient narrator.
      Diction is formal and precise; elevated vocabulary a
      21st-century reader finds old-fashioned (earnestly,
      whereupon, countenance, acquainted) is appropriate and
      should be preserved rather than modernized. Dialogue uses
      the period's politeness formulas — honorifics, titles, set
      forms of address — unless the source deliberately subverts
      them. Do not contract or compress for pace; the ornate
      rhythm is part of the voice and the period marker.
    `),
  },
  {
    id: "historical_fiction",
    name: "Historical fiction (period-set)",
    description:
      "Period-set storytelling. Era-appropriate voice and vocabulary with no modern anachronism.",
    prompt_block: normalize(`
      Translate as historical fiction set in a specific era.
      Honor period-appropriate vocabulary, idiom, and rhetorical
      cadence without slipping into modern colloquialism or
      anachronism. Place names, institutions, titles of office,
      weights and measures, currencies, and technology must
      reflect the source era; do not silently modernize them.
      When the source uses period dialect — peasant speech,
      courtly speech, soldier's argot — approximate it in the
      target language with the equivalent register rather than
      flattening to contemporary neutral prose. Keep the
      narrator's distance: a 19th-century omniscient narrator
      stays 19th-century, a close-third contemporary narrator
      looking back stays contemporary.
    `),
  },
  {
    id: "children_picture",
    name: "Children - picture book / early readers",
    description:
      "Short, concrete sentences for ages ~3-7. Read-aloud cadence.",
    prompt_block: normalize(`
      Translate for very young readers (roughly ages 3-7) and for an
      adult reading aloud. Prefer short, concrete sentences with a
      clear musical rhythm. Use vocabulary a small child already
      knows; gloss any unavoidable rare word in-line. Keep
      onomatopoeia, repetition, and rhyme when the source uses them
      — re-rhyme in the target language even if it requires a small
      departure from the literal source phrasing. Avoid irony,
      sarcasm, or jargon.
    `),
  },
  {
    id: "middle_grade",
    name: "Middle grade (ages 8-12)",
    description:
      "Clear, brisk prose for 8-12 year olds. Light humor allowed.",
    prompt_block: normalize(`
      Translate for middle-grade readers (roughly ages 8-12).
      Sentences are clear and brisk, with concrete imagery and a
      warm narrator voice. Light humor is welcome; cynicism and
      graphic content are not. Vocabulary should be slightly above
      a child's everyday speech but never gatekeeping — when the
      source uses a difficult word with intent, keep it; when it
      uses one without intent, prefer the simpler equivalent.
      Honorifics, slang, and pop-culture references should match
      the target culture's middle-grade norms.
    `),
  },
  {
    id: "young_adult",
    name: "Young adult (teen / YA)",
    description:
      "Contemporary teen voice. Punchy dialogue, real emotional stakes.",
    prompt_block: normalize(`
      Translate as young-adult fiction for a teen audience. The
      narrator's voice and any first-person POV should feel
      current and emotionally honest — neither overly sanitized
      nor performatively edgy. Dialogue is punchy and contracted;
      interiority is allowed to be raw. Mild profanity, romantic
      tension, and difficult emotional content should land with
      the same intensity they have in the source — do not soften
      them, but do not amplify them either. Slang should match
      the target language's contemporary teen register.
    `),
  },
  {
    id: "fairytale_folklore",
    name: "Fairytale / folklore / mythology",
    description:
      "Oral-tradition cadence. Formulaic openings, archaic phrasing, moral weight carried by rhythm.",
    prompt_block: normalize(`
      Translate as fairytale, folklore, fable, or mythology.
      The register is oral and archaic: formulaic openings
      ("Once upon a time", "In the days when beasts could
      speak"), stock epithets, and refrain-like repetition are
      structural features, not mannerisms — preserve them with
      the target language's equivalent traditional formulas.
      Vocabulary leans toward plain nouns and strong verbs;
      moral weight is carried by rhythm and repetition rather
      than by explicit narration. Character archetypes (the
      youngest son, the old woman at the crossroads, the
      ungrateful king) retain their flat, emblematic quality.
      Magical or sacred thresholds — three trials, seven years,
      a river the hero must not cross — are preserved verbatim;
      do not update the numbers or symbols.
    `),
  },
  {
    id: "genre_fiction",
    name: "Adult genre fiction (thriller / fantasy / SF)",
    description:
      "Pacey adult genre prose. Vivid action, clean dialogue beats.",
    prompt_block: normalize(`
      Translate as adult genre fiction (thriller, fantasy, science
      fiction, mystery, etc.). Keep the prose pacey: short
      sentences in action, longer sentences in interiority and
      world-building. Preserve invented terminology exactly as
      given by the glossary; do not 'normalize' magical, technical,
      or sci-fi vocabulary. Dialogue should feel natural and
      character-specific. Violence and tension land with the
      source's intensity; do not soften.
    `),
  },
  {
    id: "noir_crime",
    name: "Noir / hard-boiled crime",
    description:
      "Terse, cynical register. Clipped dialogue, urban grit, stoic interiority.",
    prompt_block: normalize(`
      Translate as noir or hard-boiled crime fiction. The prose
      is terse, stylized, and worldly-cynical. Sentences run
      short; dialogue is clipped, frequently interrupted, and
      attributed with simple "said" verbs rather than ornamental
      speech tags. Urban geography is specific and often grim;
      keep street names, districts, and period brands verbatim
      unless the glossary localizes them. Period slang ("dame",
      "mug", "rap sheet") lands with an era-equivalent idiom in
      the target language rather than a gloss. Metaphors are
      concrete and bruising; interiority is stoic and
      understated — first-person narrators confess by
      implication, not by monologue. Violence lands with the
      source's matter-of-fact intensity; do not soften.
    `),
  },
  {
    id: "horror_gothic",
    name: "Horror / gothic",
    description:
      "Atmospheric dread. Controlled pacing, sensory detail, deliberate ambiguity.",
    prompt_block: normalize(`
      Translate as horror or gothic fiction. The register is
      atmospheric and patient: dread is built from sensory
      detail, controlled pacing, and silences rather than
      explicit shock. Let long, lulling sentences in descriptive
      passages do their hypnotic work; let short, stark
      sentences at the turn land with impact. Preserve
      body-horror and uncanny specifics verbatim — do not soften
      visceral detail — and preserve the deliberate ambiguity
      of unreliable narrators (what was, and what might have
      been). Archaic or regional vocabulary that heightens the
      uncanny (gothic-era diction, folk-horror dialect) should
      land with a period-appropriate equivalent in the target
      language rather than being modernized away.
    `),
  },
  {
    id: "cozy_romance",
    name: "Romance — cozy / closed-door",
    description:
      "Warm romantic register. Emotional intimacy without explicit content.",
    prompt_block: normalize(`
      Translate as a cozy / closed-door romance. The register is
      warm, intimate, and emotionally generous; the focus is on
      longing, banter, and emotional vulnerability rather than
      physical detail. When the source describes physical intimacy
      it does so by implication — keep that implication intact;
      do not add explicit detail and do not blur over what the
      source explicitly shows. Inner monologue is welcome.
      Endearments and pet names should land naturally in the
      target language's romantic vocabulary.
    `),
  },
  {
    id: "explicit_adult",
    name: "Adult — explicit / erotic",
    description:
      "Adult-only. Explicit physical and sexual content is preserved verbatim.",
    prompt_block: normalize(`
      Translate as adult fiction for an adult audience. Explicit
      sexual, sensual, or graphic content must be preserved in
      full — do not soften, paraphrase, or summarize physical
      description, anatomical vocabulary, or sexual acts.
      Consensual, non-consensual, and morally complex situations
      in the source must land with the same explicitness in the
      target. Match the source's register: when it is filthy or
      casual, the translation is filthy or casual; when it is
      literary or tender, the translation is literary or tender.
      Do not add disclaimers, warnings, or content notices that
      are not in the source.
    `),
  },
  {
    id: "humor_comedy",
    name: "Humor / comedy",
    description:
      "Comic timing is the product. Wordplay, understatement, and rhythm over literal accuracy.",
    prompt_block: normalize(`
      Translate as humor or comedy. The product is the laugh;
      when a literal translation kills the joke, rewrite the
      joke so it lands in the target language. Puns, wordplay,
      running gags, and comic misnaming are structural — find
      target-language equivalents rather than preserving the
      source words verbatim. Understatement, deadpan delivery,
      and comic timing (the set-up / pause / punch-line rhythm)
      must survive even when every individual word changes.
      Cultural references the target reader wouldn't recognize
      get naturalized to an equivalent the reader will
      recognize, unless the joke is specifically about the
      foreignness itself. Keep the narrator's attitude —
      bemused, caustic, affectionate, absurdist — consistent
      from scene to scene.
    `),
  },
  {
    id: "memoir_biography",
    name: "Memoir / biography",
    description:
      "Reflective nonfiction. First-person voice, scene-and-summary rhythm, controlled emotion.",
    prompt_block: normalize(`
      Translate as memoir or biography. The register is
      reflective and voice-forward: a first-person (or close
      third, for biography) narrator looks back on lived events
      with emotional distance and occasional candor. Keep the
      signature tics of the original voice — sentence length,
      digressions, self-deprecating asides — intact even when
      they would be trimmed in fiction. Private names,
      nicknames, and family idiolect stay verbatim unless the
      glossary specifies otherwise. Quoted remembered speech
      lands in the target language's colloquial register
      without losing the specificity of the remembered voice.
      Factual specifics — dates, places, titles, institutions
      — are precise and not stylized away.
    `),
  },
  {
    id: "poetry_verse",
    name: "Poetry / verse",
    description:
      "Verse form is the text. Meter, line breaks, and sound patterns take priority over literalism.",
    prompt_block: normalize(`
      Translate as poetry or verse. The formal features —
      meter, line breaks, stanza shape, rhyme scheme, internal
      sound patterns — are load-bearing, not decorative.
      Preserve line and stanza boundaries exactly; preserve the
      rhyme scheme (A/B/A/B, couplets, etc.) in the target
      language even at the cost of literal word-for-word
      fidelity. Meter should match the source's pulse (iambic,
      syllabic, free) as naturally as the target language
      allows. Figurative language — metaphor, metonymy,
      ambiguity — survives as ambiguity; do not resolve double
      meanings into a single reading. Titles, epigraphs, and
      dedications carry the same weight as body text.
    `),
  },
  {
    id: "religious_spiritual",
    name: "Religious / spiritual",
    description:
      "Reverent register. Liturgical vocabulary, canonical phrasing, quoted scripture verbatim.",
    prompt_block: normalize(`
      Translate as religious or spiritual prose. The register is
      reverent and carefully weighted; the target language's
      established liturgical vocabulary (for prayer, scripture,
      ritual, clerical titles) is preferred over neutral
      everyday synonyms. Quoted scripture or recognized sacred
      passages should match the canonical translation used in
      the target tradition when one exists; do not paraphrase
      them. Honorifics, names of the divine, and titles of
      clergy follow the target tradition's capitalization and
      form. Theological terminology is precise and not to be
      loosened (incarnation ≠ embodiment; grace ≠ kindness).
      Preserve the source's tone — contemplative, devotional,
      admonitory, celebratory — paragraph by paragraph.
    `),
  },
  {
    id: "technical_manual",
    name: "Technical manual / how-to",
    description: "Precise, instructional. Terminology is non-negotiable.",
    prompt_block: normalize(`
      Translate as a technical manual or how-to. Precision over
      elegance: prefer the unambiguous wording even when it is
      less literary. Domain terminology, command names, function
      signatures, units, and product names must land verbatim
      unless the glossary specifies a localized term. Use the
      target language's standard imperative form for instructions.
      Numbered steps, code blocks, and notes/warnings retain their
      structure exactly. Do not introduce stylistic flourishes the
      source does not have.
    `),
  },
  {
    id: "academic",
    name: "Academic / scholarly",
    description:
      "Formal scholarly register. Citations and hedged claims preserved.",
    prompt_block: normalize(`
      Translate as academic / scholarly prose. Use the target
      language's formal scholarly register. Hedged claims ("might
      suggest", "appears to indicate") stay hedged; assertive
      claims stay assertive. Citations, footnote markers, figure
      references, and technical terminology must land verbatim.
      Latin / Greek / French scholarly idioms (e.g. ibid., cf.,
      i.e., a priori) are preserved unless the target academic
      tradition uses a different convention. Maintain the
      source's argumentative structure paragraph by paragraph.
    `),
  },
  {
    id: "journalistic",
    name: "Journalistic / reportage",
    description:
      "Newsroom register. Compact leads, attributed quotes, neutral tone.",
    prompt_block: normalize(`
      Translate as journalism / reportage. Newsroom register:
      compact leads, attributed quotes preserved verbatim where
      possible, neutral framing. Attributions ("said", "according
      to") use the target language's standard reporting verbs.
      Numbers, dates, place names, and titles match the target
      country's house-style conventions. Do not editorialize
      beyond what the source already does. Headlines, datelines,
      and bylines retain their structural cues.
    `),
  },
] as const;

export const PROFILE_REGISTRY: ReadonlyMap<string, StyleProfile> = new Map(
  PROFILES.map((p) => [p.id, p]),
);

export function listProfiles(): readonly StyleProfile[] {
  return PROFILES;
}

export function getProfile(profileId: string): StyleProfile | null {
  return PROFILE_REGISTRY.get(profileId) ?? null;
}

/**
 * Compute the actual style-guide text to persist on a project row.
 *
 * Resolution order:
 * 1. `custom_text` is used verbatim when truthy.
 * 2. Otherwise the registered profile's `prompt_block` is used.
 * 3. Returns null when no profile id and no custom text were given.
 */
export function resolveStyleGuide({
  profile_id,
  custom_text,
}: {
  profile_id: string | null;
  custom_text?: string | null;
}): string | null {
  if (custom_text != null) {
    const cleaned = custom_text.trim();
    if (cleaned) return cleaned;
  }
  if (profile_id == null) return null;
  const profile = PROFILE_REGISTRY.get(profile_id);
  return profile?.prompt_block ?? null;
}

/**
 * Map a helper-LLM `(register, audience)` to one of our preset ids.
 *
 * Returns null when nothing matches — the caller should fall back to
 * the project's current setting (or DEFAULT_STYLE_PROFILE for fresh
 * projects). The mapping is intentionally conservative: ambiguous or
 * unrecognized values produce null rather than guessing wildly.
 */
export function suggestStyleProfile({
  register,
  audience,
}: {
  register: string | null;
  audience: string | null;
}): string | null {
  const norm_audience = normalizeToken(audience);
  const norm_register = normalizeToken(register);

  if (
    norm_audience &&
    ["children", "kids", "picture", "early_reader"].includes(norm_audience)
  ) {
    return "children_picture";
  }
  if (
    norm_audience &&
    ["middle_grade", "middle", "tween"].includes(norm_audience)
  ) {
    return "middle_grade";
  }
  if (
    norm_audience &&
    ["young_adult", "ya", "teen", "teenager"].includes(norm_audience)
  ) {
    return "young_adult";
  }

  if (norm_register) {
    if (
      ["explicit", "erotic", "erotica", "adult_explicit"].includes(
        norm_register,
      )
    ) {
      return "explicit_adult";
    }
    if (
      ["technical", "instructional", "how_to", "manual"].includes(norm_register)
    ) {
      return "technical_manual";
    }
    if (norm_register === "academic") return "academic";
    if (["journalistic", "news", "reportage"].includes(norm_register)) {
      return "journalistic";
    }
    if (
      [
        "religious",
        "sacred",
        "spiritual",
        "liturgical",
        "devotional",
        "theological",
      ].includes(norm_register)
    ) {
      return "religious_spiritual";
    }
    if (
      ["poetry", "poetic", "verse", "lyric", "lyrical"].includes(norm_register)
    ) {
      return "poetry_verse";
    }
    if (
      [
        "memoir",
        "autobiography",
        "autobiographical",
        "biography",
        "biographical",
      ].includes(norm_register)
    ) {
      return "memoir_biography";
    }
    if (
      ["horror", "gothic", "supernatural_horror"].includes(norm_register)
    ) {
      return "horror_gothic";
    }
    if (["noir", "hardboiled", "hard_boiled"].includes(norm_register)) {
      return "noir_crime";
    }
    if (["romantic", "romance", "cozy_romance"].includes(norm_register)) {
      return "cozy_romance";
    }
    if (
      [
        "humor",
        "humorous",
        "comedy",
        "comedic",
        "satire",
        "satirical",
      ].includes(norm_register)
    ) {
      return "humor_comedy";
    }
    if (
      [
        "fairytale",
        "fairy_tale",
        "folklore",
        "folktale",
        "folk_tale",
        "fable",
        "myth",
        "mythology",
        "legend",
      ].includes(norm_register)
    ) {
      return "fairytale_folklore";
    }
    if (
      ["historical", "period", "historical_fiction"].includes(norm_register)
    ) {
      return "historical_fiction";
    }
    if (
      [
        "classic",
        "classical",
        "victorian",
        "edwardian",
        "nineteenth_century",
        "19th_century",
        "early_twentieth_century",
      ].includes(norm_register)
    ) {
      return "classic_literature";
    }
    if (["genre", "thriller", "fantasy", "sf", "scifi"].includes(norm_register)) {
      return "genre_fiction";
    }
  }

  if (
    norm_audience &&
    ["adult", "general"].includes(norm_audience) &&
    (norm_register === null ||
      ["literary", "literary_fiction", "neutral"].includes(norm_register))
  ) {
    return "literary_fiction";
  }
  return null;
}

function normalizeToken(value: string | null | undefined): string | null {
  if (value == null) return null;
  let cleaned = value.trim().toLowerCase();
  if (!cleaned) return null;
  cleaned = cleaned.replace(/-/g, "_").replace(/\s+/g, "_");
  while (cleaned.includes("__")) cleaned = cleaned.replace(/__/g, "_");
  return cleaned;
}

/**
 * Friendly label for a profile id, including the "Custom" / "Unknown" cases.
 */
export function labelForProfile(profileId: string | null): string {
  if (profileId == null) return "Custom";
  const profile = PROFILE_REGISTRY.get(profileId);
  if (!profile) return `Unknown (${profileId})`;
  return profile.name;
}

/** `(name, id)` tuples suitable for a Select dropdown. */
export function profileChoices(): readonly { value: string; label: string }[] {
  return PROFILES.map((p) => ({ value: p.id, label: p.name }));
}
