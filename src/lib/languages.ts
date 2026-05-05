/**
 * BCP-47 language inventory shared by the project / settings UIs and
 * the translator-prompt builder.
 *
 * The list is curated rather than exhaustive — it covers the locales
 * we've actually seen in real ePubs plus the common Latin-American
 * Portuguese / Spanish flavours that translators ask for the most. We
 * tag each entry with a *display label* (e.g. "Portuguese (Brazil)") so
 * the autocomplete UI can show something meaningful while still binding
 * the raw BCP-47 tag to the database.
 *
 * `findLanguage` and `isKnownLanguage` are case-insensitive *and* tag
 * normalisation aware — `pt-BR` and `PT-br` both match the same record.
 * If you pass a region/script-tagged code we don't know about, we fall
 * back to the primary tag (`pt-AO` → `pt`) so the validator stays
 * permissive: any tag whose primary subtag is recognised is "valid".
 */

export interface LanguageOption {
  /** Canonical BCP-47 tag, formatted with the conventional casing
   *  (lowercase primary tag, uppercase region, capitalized script). */
  code: string;
  /** Human-readable label shown in the picker. */
  name: string;
  /** Lowercased lookup key (canonical for case-insensitive matching). */
  key: string;
  /** Lowercased primary subtag (left of the first `-`). */
  primary: string;
}

/** Format a raw BCP-47 tag with the conventional casing.
 *  Example: `pt-br` → `pt-BR`, `zh-hant-tw` → `zh-Hant-TW`. */
function canonicalizeTag(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const parts = trimmed.split("-").filter(Boolean);
  if (parts.length === 0) return trimmed;
  const out: string[] = [parts[0].toLowerCase()];
  for (let i = 1; i < parts.length; i += 1) {
    const seg = parts[i];
    if (seg.length === 4) {
      // Script subtag — Title Case.
      out.push(seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase());
    } else if (seg.length === 2 || seg.length === 3) {
      // Region subtag (alpha-2/3) → upper; numeric region (e.g. 419) →
      // verbatim digits.
      out.push(/^\d+$/.test(seg) ? seg : seg.toUpperCase());
    } else {
      out.push(seg.toLowerCase());
    }
  }
  return out.join("-");
}

interface LanguageSeed {
  code: string;
  name: string;
}

const SEEDS: LanguageSeed[] = [
  { code: "en", name: "English" },
  { code: "en-US", name: "English (United States)" },
  { code: "en-GB", name: "English (United Kingdom)" },
  { code: "en-AU", name: "English (Australia)" },
  { code: "en-CA", name: "English (Canada)" },
  { code: "en-IE", name: "English (Ireland)" },
  { code: "en-IN", name: "English (India)" },
  { code: "en-NZ", name: "English (New Zealand)" },
  { code: "en-ZA", name: "English (South Africa)" },

  { code: "pt", name: "Portuguese" },
  { code: "pt-BR", name: "Portuguese (Brazil)" },
  { code: "pt-PT", name: "Portuguese (Portugal)" },
  { code: "pt-AO", name: "Portuguese (Angola)" },
  { code: "pt-MZ", name: "Portuguese (Mozambique)" },

  { code: "es", name: "Spanish" },
  { code: "es-ES", name: "Spanish (Spain)" },
  { code: "es-MX", name: "Spanish (Mexico)" },
  { code: "es-AR", name: "Spanish (Argentina)" },
  { code: "es-CO", name: "Spanish (Colombia)" },
  { code: "es-CL", name: "Spanish (Chile)" },
  { code: "es-419", name: "Spanish (Latin America)" },

  { code: "fr", name: "French" },
  { code: "fr-FR", name: "French (France)" },
  { code: "fr-CA", name: "French (Canada)" },
  { code: "fr-BE", name: "French (Belgium)" },
  { code: "fr-CH", name: "French (Switzerland)" },

  { code: "it", name: "Italian" },
  { code: "it-IT", name: "Italian (Italy)" },
  { code: "it-CH", name: "Italian (Switzerland)" },

  { code: "de", name: "German" },
  { code: "de-DE", name: "German (Germany)" },
  { code: "de-AT", name: "German (Austria)" },
  { code: "de-CH", name: "German (Switzerland)" },

  { code: "nl", name: "Dutch" },
  { code: "nl-NL", name: "Dutch (Netherlands)" },
  { code: "nl-BE", name: "Dutch (Belgium / Flemish)" },

  { code: "ca", name: "Catalan" },
  { code: "gl", name: "Galician" },
  { code: "eu", name: "Basque" },

  { code: "no", name: "Norwegian" },
  { code: "nb", name: "Norwegian (Bokmål)" },
  { code: "nn", name: "Norwegian (Nynorsk)" },
  { code: "sv", name: "Swedish" },
  { code: "da", name: "Danish" },
  { code: "fi", name: "Finnish" },
  { code: "is", name: "Icelandic" },
  { code: "et", name: "Estonian" },
  { code: "lv", name: "Latvian" },
  { code: "lt", name: "Lithuanian" },

  { code: "ru", name: "Russian" },
  { code: "uk", name: "Ukrainian" },
  { code: "be", name: "Belarusian" },
  { code: "pl", name: "Polish" },
  { code: "cs", name: "Czech" },
  { code: "sk", name: "Slovak" },
  { code: "hu", name: "Hungarian" },
  { code: "ro", name: "Romanian" },
  { code: "bg", name: "Bulgarian" },
  { code: "hr", name: "Croatian" },
  { code: "sr", name: "Serbian" },
  { code: "sr-Latn", name: "Serbian (Latin)" },
  { code: "sr-Cyrl", name: "Serbian (Cyrillic)" },
  { code: "sl", name: "Slovenian" },
  { code: "mk", name: "Macedonian" },
  { code: "sq", name: "Albanian" },
  { code: "el", name: "Greek" },

  { code: "ar", name: "Arabic" },
  { code: "ar-EG", name: "Arabic (Egypt)" },
  { code: "ar-SA", name: "Arabic (Saudi Arabia)" },
  { code: "ar-LB", name: "Arabic (Lebanon)" },
  { code: "ar-MA", name: "Arabic (Morocco)" },
  { code: "he", name: "Hebrew" },
  { code: "fa", name: "Persian (Farsi)" },
  { code: "ur", name: "Urdu" },
  { code: "ps", name: "Pashto" },
  { code: "ku", name: "Kurdish" },

  { code: "tr", name: "Turkish" },
  { code: "az", name: "Azerbaijani" },
  { code: "hy", name: "Armenian" },
  { code: "ka", name: "Georgian" },

  { code: "hi", name: "Hindi" },
  { code: "bn", name: "Bengali" },
  { code: "pa", name: "Punjabi" },
  { code: "gu", name: "Gujarati" },
  { code: "mr", name: "Marathi" },
  { code: "ta", name: "Tamil" },
  { code: "te", name: "Telugu" },
  { code: "kn", name: "Kannada" },
  { code: "ml", name: "Malayalam" },
  { code: "si", name: "Sinhala" },
  { code: "ne", name: "Nepali" },

  { code: "zh", name: "Chinese" },
  { code: "zh-CN", name: "Chinese (Simplified, China)" },
  { code: "zh-TW", name: "Chinese (Traditional, Taiwan)" },
  { code: "zh-HK", name: "Chinese (Hong Kong)" },
  { code: "zh-Hans", name: "Chinese (Simplified)" },
  { code: "zh-Hant", name: "Chinese (Traditional)" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "mn", name: "Mongolian" },

  { code: "id", name: "Indonesian" },
  { code: "ms", name: "Malay" },
  { code: "vi", name: "Vietnamese" },
  { code: "th", name: "Thai" },
  { code: "lo", name: "Lao" },
  { code: "km", name: "Khmer" },
  { code: "my", name: "Burmese" },
  { code: "tl", name: "Tagalog" },
  { code: "fil", name: "Filipino" },

  { code: "sw", name: "Swahili" },
  { code: "am", name: "Amharic" },
  { code: "yo", name: "Yoruba" },
  { code: "ha", name: "Hausa" },
  { code: "ig", name: "Igbo" },
  { code: "zu", name: "Zulu" },
  { code: "xh", name: "Xhosa" },
  { code: "af", name: "Afrikaans" },

  { code: "la", name: "Latin" },
  { code: "eo", name: "Esperanto" },
];

const _byKey = new Map<string, LanguageOption>();

export const LANGUAGES: ReadonlyArray<LanguageOption> = SEEDS.map((seed) => {
  const code = canonicalizeTag(seed.code);
  const key = code.toLowerCase();
  const primary = key.split("-", 1)[0] ?? key;
  const opt: LanguageOption = { code, name: seed.name, key, primary };
  _byKey.set(key, opt);
  return opt;
});

/** Look up a language record (case-insensitive).
 *  Returns the canonical record when the primary subtag is known
 *  (`pt-AO` → the `pt` record), or `null` when nothing matches. */
export function findLanguage(raw: string | null | undefined): LanguageOption | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  const direct = _byKey.get(key);
  if (direct) return direct;
  const primary = key.split("-", 1)[0] ?? key;
  if (primary !== key) {
    const fallback = _byKey.get(primary);
    if (fallback) return fallback;
  }
  return null;
}

/** Is the tag (or its primary subtag) something we recognize?
 *  Used to power the form-level validation pulse. */
export function isKnownLanguage(raw: string | null | undefined): boolean {
  return findLanguage(raw) !== null;
}

/** Display label for a tag, robust to unknown codes:
 *    `pt-BR` → "Portuguese (Brazil)"
 *    `pt-AO` → "Portuguese (pt-AO)"  (primary known, region not)
 *    `xx-YY` → "xx-YY"               (totally unknown)
 */
export function describeLanguage(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  const exact = _byKey.get(trimmed.toLowerCase());
  if (exact) return exact.name;
  const fallback = findLanguage(trimmed);
  if (fallback) return `${fallback.name} (${trimmed})`;
  return trimmed;
}

/** Return a filtered, alphabetically-sorted slice of the inventory
 *  matching `query` (case-insensitive substring match against either
 *  the BCP-47 tag or the human-readable name). */
export function searchLanguages(
  query: string | null | undefined,
  limit = 12,
): LanguageOption[] {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return LANGUAGES.slice(0, limit);
  const exact: LanguageOption[] = [];
  const prefix: LanguageOption[] = [];
  const contains: LanguageOption[] = [];
  for (const opt of LANGUAGES) {
    const lc = opt.name.toLowerCase();
    if (opt.key === q) exact.push(opt);
    else if (opt.key.startsWith(q) || lc.startsWith(q)) prefix.push(opt);
    else if (opt.key.includes(q) || lc.includes(q)) contains.push(opt);
  }
  return [...exact, ...prefix, ...contains].slice(0, limit);
}

export { canonicalizeTag };
