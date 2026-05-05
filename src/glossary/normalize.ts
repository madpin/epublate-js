/**
 * Glossary particle / lemma normalization.
 *
 * Mirrors `epublate.glossary.normalize` verbatim. Three call sites:
 *
 * 1. **Auto-proposer** (`io.ts/upsertProposed`) strips a leading
 *    function word from both source and target before insert so the
 *    helper LLM always lands a symmetric pair.
 * 2. **Curator save** (`EntryEditDialog`) calls `analyzePair` and
 *    rejects asymmetric pairs.
 * 3. **Translator validator** (`pipeline.ts`) calls
 *    `findDoubledParticles` on the LLM target output and flags
 *    `"na na"` / `"the the"` runs.
 *
 * Per-language sets are conservative — adding a particle has to not
 * regress real-world entries.
 */

const _LEADING_PARTICLES: Record<string, ReadonlySet<string>> = {
  en: new Set(["the", "a", "an"]),
  pt: new Set([
    "o",
    "a",
    "os",
    "as",
    "um",
    "uma",
    "uns",
    "umas",
    "de",
    "em",
    "por",
    "para",
    "com",
    "do",
    "da",
    "dos",
    "das",
    "no",
    "na",
    "nos",
    "nas",
    "ao",
    "à",
    "aos",
    "às",
    "pelo",
    "pela",
    "pelos",
    "pelas",
    "num",
    "numa",
    "nuns",
    "numas",
    "dum",
    "duma",
    "duns",
    "dumas",
  ]),
  es: new Set([
    "el",
    "la",
    "los",
    "las",
    "un",
    "una",
    "unos",
    "unas",
    "de",
    "en",
    "por",
    "para",
    "con",
    "del",
    "al",
  ]),
  fr: new Set([
    "le",
    "la",
    "les",
    "un",
    "une",
    "des",
    "de",
    "en",
    "à",
    "du",
    "au",
    "aux",
  ]),
  it: new Set([
    "il",
    "lo",
    "la",
    "i",
    "gli",
    "le",
    "un",
    "uno",
    "una",
    "di",
    "in",
    "a",
    "da",
    "su",
    "per",
    "con",
    "del",
    "dello",
    "della",
    "dei",
    "degli",
    "delle",
    "al",
    "allo",
    "alla",
    "ai",
    "agli",
    "alle",
    "dal",
    "dallo",
    "dalla",
    "dai",
    "dagli",
    "dalle",
    "nel",
    "nello",
    "nella",
    "nei",
    "negli",
    "nelle",
    "sul",
    "sullo",
    "sulla",
    "sui",
    "sugli",
    "sulle",
  ]),
  de: new Set([
    "der",
    "die",
    "das",
    "den",
    "dem",
    "des",
    "ein",
    "eine",
    "einen",
    "einem",
    "einer",
    "eines",
    "in",
    "an",
    "auf",
    "zu",
    "von",
    "mit",
    "bei",
    "im",
    "am",
    "zum",
    "zur",
    "vom",
    "beim",
  ]),
};

/**
 * Unicode-aware word tokenizer.
 *
 * `\p{L}+` matches any Unicode letter run; the optional
 * `'\p{L}+` tail keeps French ``l'``-style elisions intact.
 * `gu` flags so we can iterate matches with `matchAll`.
 */
const _WORD_RE = /\p{L}+(?:'\p{L}+)?/gu;

export interface NormalizedTerm {
  original: string;
  stripped: string;
  particle: string | null;
}

export interface ParticleSymmetry {
  symmetric: boolean;
  source_particle: string | null;
  target_particle: string | null;
  message: string;
}

function _resolveLang(lang: string | null | undefined): string {
  if (!lang) return "en";
  return lang.split("-")[0]!.split("_")[0]!.toLowerCase();
}

function _particlesFor(
  lang: string | null | undefined,
): ReadonlySet<string> {
  return _LEADING_PARTICLES[_resolveLang(lang)] ?? _LEADING_PARTICLES.en!;
}

const TRIM_PUNCT = ".,;:!?'\"`«»()[]{}";

function trimPunct(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && TRIM_PUNCT.includes(s[start]!)) start++;
  while (end > start && TRIM_PUNCT.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}

/**
 * Return the lower-cased leading article/preposition, or `null`.
 *
 * Only single-token prefixes are matched. Multi-word prefixes (`"of the"`)
 * are intentionally out of scope; `analyzePair`'s symmetry check still
 * catches the asymmetric cases.
 */
export function leadingParticle(
  text: string,
  opts: { lang: string | null | undefined },
): string | null {
  const cleaned = text.trim();
  if (!cleaned) return null;
  const idx = cleaned.search(/\s/u);
  if (idx === -1) {
    // A bare ``"the"`` entry is almost certainly garbage — refuse
    // to claim it's a particle so the symmetry check can flag it.
    return null;
  }
  const head = trimPunct(cleaned.slice(0, idx)).toLowerCase();
  if (!head) return null;
  return _particlesFor(opts.lang).has(head) ? head : null;
}

/**
 * Strip a single leading article/preposition (lemma form).
 *
 * Removes only the *first* token. ``"of the United States"`` becomes
 * ``"the United States"`` (still has ``"the"``); apply
 * `normalizeTerm` again for full-depth stripping. We don't recurse
 * because multi-word prefixes are rare enough that the symmetry check
 * is a better safety net.
 */
export function normalizeTerm(
  text: string,
  opts: { lang: string | null | undefined },
): NormalizedTerm {
  const cleaned = text.trim();
  if (!cleaned) {
    return { original: text, stripped: "", particle: null };
  }
  const particle = leadingParticle(cleaned, opts);
  if (particle === null) {
    return { original: text, stripped: cleaned, particle: null };
  }
  const idx = cleaned.search(/\s/u);
  if (idx === -1) {
    return { original: text, stripped: cleaned, particle: null };
  }
  const tail = cleaned.slice(idx).trim();
  if (!tail) {
    return { original: text, stripped: cleaned, particle: null };
  }
  return { original: text, stripped: tail, particle };
}

/**
 * Check whether a glossary pair has symmetric leading particles.
 *
 * Target-only entries (`source_term === null`) are trivially symmetric:
 * they pin a canonical target spelling and the validator's
 * anti-doubling check keeps them safe regardless.
 */
export function analyzePair(opts: {
  source_term: string | null;
  target_term: string;
  source_lang: string | null | undefined;
  target_lang: string | null | undefined;
}): ParticleSymmetry {
  const { source_term, target_term, source_lang, target_lang } = opts;
  if (source_term === null) {
    return {
      symmetric: true,
      source_particle: null,
      target_particle: leadingParticle(target_term, { lang: target_lang }),
      message: "",
    };
  }

  const src = leadingParticle(source_term, { lang: source_lang });
  const tgt = leadingParticle(target_term, { lang: target_lang });
  if ((src === null) === (tgt === null)) {
    return {
      symmetric: true,
      source_particle: src,
      target_particle: tgt,
      message: "",
    };
  }

  if (src === null) {
    return {
      symmetric: false,
      source_particle: src,
      target_particle: tgt,
      message:
        `target '${target_term}' starts with '${tgt}' but the source ` +
        `'${source_term}' has no matching article/preposition. ` +
        "Either remove the leading word from the target (lemma form) " +
        "or prepend a matching article/preposition to the source.",
    };
  }
  return {
    symmetric: false,
    source_particle: src,
    target_particle: tgt,
    message:
      `source '${source_term}' starts with '${src}' but the target ` +
      `'${target_term}' has no matching article/preposition. ` +
      "Either remove the leading word from the source (lemma form) " +
      "or prepend a matching article/preposition to the target.",
  };
}

/**
 * Find ``"na na"`` / ``"the the"`` adjacent-particle runs.
 *
 * Returns `[[particle, charOffset], …]` for every adjacent pair of
 * *identical* function words (case-insensitive) in `text`. The pair
 * must be word-adjacent — `"in. In"` across a sentence boundary is
 * not flagged.
 */
export function findDoubledParticles(
  text: string,
  opts: { lang: string | null | undefined; extra_particles?: readonly string[] },
): Array<[string, number]> {
  const base = _particlesFor(opts.lang);
  const extras = new Set(
    (opts.extra_particles ?? []).map((p) => p.toLowerCase()),
  );
  const particles = new Set([...base, ...extras]);
  const out: Array<[string, number]> = [];
  // Reset regex state — _WORD_RE is shared and stateful.
  const re = new RegExp(_WORD_RE.source, _WORD_RE.flags);
  const matches: Array<{ word: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({ word: m[0], index: m.index });
    if (m[0].length === 0) re.lastIndex++;
  }
  for (let i = 0; i < matches.length - 1; i++) {
    const m1 = matches[i]!;
    const m2 = matches[i + 1]!;
    const head = m1.word.toLowerCase();
    if (head !== m2.word.toLowerCase()) continue;
    if (!particles.has(head)) continue;
    out.push([head, m1.index]);
  }
  return out;
}
