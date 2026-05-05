/**
 * Subset of named entities that the segmenter expands inline to a
 * literal Unicode character at *placeholderize* time, exactly as the
 * Python `_TEXT_ENTITY_EXPANSIONS` does.
 *
 * The browser parser already substituted these to literal chars in
 * `expandNamedEntities`, so by the time `placeholderize` runs we won't
 * see entity-reference nodes for any of these. This map exists so:
 *
 *   - downstream tooling (project-import migration) can match the
 *     Python behaviour exactly when given a stored skeleton from the
 *     Python tool;
 *   - tests can introspect the canonical expansion list.
 */
export const TEXT_ENTITY_EXPANSIONS: Record<string, string> = {
  apos: "'",
  quot: '"',
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  sbquo: "\u201a",
  bdquo: "\u201e",
  laquo: "\u00ab",
  raquo: "\u00bb",
  prime: "\u2032",
  Prime: "\u2033",
  ndash: "\u2013",
  mdash: "\u2014",
  horbar: "\u2015",
  hellip: "\u2026",
  nbsp: "\u00a0",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  hairsp: "\u200a",
  numsp: "\u2007",
  puncsp: "\u2008",
  amp: "&",
};
