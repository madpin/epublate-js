/**
 * Reader-friendly rendering of placeholder-bearing segment text.
 *
 * Mirrors `epublate.app.preview` (Rich-markup) but emits React nodes
 * instead. Inline tokens are mapped onto semantic HTML tags (`<em>`,
 * `<strong>`, `<a>`, …) so the active theme styles them through CSS
 * rather than inline color codes. Entities expand to their Unicode
 * character; void tokens (`<br/>`, `<hr/>`, image placeholders) become
 * compact in-text markers — the curator sees the *shape* of the
 * paragraph without the noise of `[[T0]]` ladders.
 *
 * The transformation is purely cosmetic; the canonical text in the DB
 * stays untouched so re-translation, validation, and reassembly all
 * keep operating on the placeholder form.
 */

import * as React from "react";

import { PLACEHOLDER_RE } from "@/formats/epub/segmentation";
import type { InlineToken } from "@/formats/epub/types";

const EMPHASIS_TAGS = new Set(["em", "i", "cite", "dfn", "var"]);
const STRONG_TAGS = new Set(["strong", "b"]);
const UNDERLINE_TAGS = new Set(["u", "ins"]);
const STRIKE_TAGS = new Set(["s", "del", "strike"]);
const CODE_TAGS = new Set(["code", "kbd", "samp", "tt"]);
const LINK_TAGS = new Set(["a"]);
const RUBY_TEXT_TAGS = new Set(["rt"]);
const RUBY_PARENS_TAGS = new Set(["rp"]);
const SUP_TAGS = new Set(["sup"]);
const SUB_TAGS = new Set(["sub"]);
const LINEBREAK_TAGS = new Set(["br"]);
const IMAGE_TAGS = new Set(["img", "image"]);

const ENTITY_PREVIEW: Record<string, string> = {
  nbsp: "\u00a0",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  shy: "\u00ad",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  deg: "°",
  para: "¶",
  sect: "§",
};

function localName(tag: string): string {
  if (tag.startsWith("{")) {
    const idx = tag.indexOf("}");
    if (idx >= 0) return tag.slice(idx + 1);
  }
  return tag;
}

interface OpenWrap {
  /** "em" | "strong" | "code" | "a" | "u" | "s" | "rt" | "sup" | "sub" | null */
  el: keyof React.JSX.IntrinsicElements | null;
  /** Optional CSS class to thread onto the element. */
  className?: string;
}

function wrapFor(tag: string): OpenWrap {
  const name = localName(tag).toLowerCase();
  if (STRONG_TAGS.has(name)) return { el: "strong" };
  if (EMPHASIS_TAGS.has(name)) return { el: "em" };
  if (UNDERLINE_TAGS.has(name)) return { el: "u" };
  if (STRIKE_TAGS.has(name)) return { el: "s" };
  if (CODE_TAGS.has(name)) return { el: "code" };
  if (LINK_TAGS.has(name)) {
    return { el: "span", className: "underline text-primary" };
  }
  if (RUBY_TEXT_TAGS.has(name)) {
    return { el: "span", className: "text-muted-foreground" };
  }
  if (RUBY_PARENS_TAGS.has(name)) return { el: null };
  if (SUP_TAGS.has(name)) return { el: "sup" };
  if (SUB_TAGS.has(name)) return { el: "sub" };
  return { el: null };
}

/**
 * Resolver for inline `<img>` tokens. The Reader passes a chapter-scoped
 * map keyed by the verbatim `src` / `href` attribute; when the lookup
 * succeeds, we render an actual `<img>` instead of the legacy
 * `[image: filename]` text marker. When the lookup fails (or no
 * resolver was supplied) we fall back to the marker.
 *
 * Pass `null` for a known-failed lookup (so that paint-once chapters
 * don't keep re-querying), or omit entirely.
 */
export type ImageResolver = (raw_src: string) => string | null | undefined;

function imageMarker(
  token: InlineToken,
  resolver?: ImageResolver,
): React.ReactNode {
  const alt = token.attrs?.alt ?? "";
  const src =
    token.attrs?.src ??
    token.attrs?.href ??
    token.attrs?.["xlink:href"] ??
    "";
  const url = resolver?.(src) ?? null;
  if (url) {
    // Inline image: render at natural size (capped) without borders /
    // backgrounds — same vibe as a typeset book illustration. The
    // legacy chrome made these read like chapter covers, which the
    // curators rightly complained about.
    return (
      <img
        src={url}
        alt={alt}
        className="my-1 inline-block max-h-72 max-w-full rounded-sm align-middle"
        loading="lazy"
      />
    );
  }
  const tail = src.split("/").pop() ?? "";
  const label = (alt && alt.trim()) || tail || "image";
  return (
    <span className="italic text-muted-foreground">[image: {label}]</span>
  );
}

function voidMarker(
  token: InlineToken,
  resolver?: ImageResolver,
): React.ReactNode {
  const name = localName(token.tag).toLowerCase();
  if (IMAGE_TAGS.has(name)) return imageMarker(token, resolver);
  if (LINEBREAK_TAGS.has(name)) return <br />;
  if (name === "hr") {
    return (
      <span aria-hidden className="block text-muted-foreground">
        ──────
      </span>
    );
  }
  if (name === "wbr") return null;
  return <span className="text-muted-foreground">{`<${name}/>`}</span>;
}

function entityMarker(token: InlineToken): React.ReactNode {
  const raw = token.attrs?.name ?? localName(token.tag).replace(/^&|;$/g, "");
  const name = raw.toLowerCase();
  const expanded = ENTITY_PREVIEW[name];
  if (expanded) return expanded;
  return <span className="text-muted-foreground">&amp;{name};</span>;
}

interface Frame {
  idx: number;
  el: keyof React.JSX.IntrinsicElements | null;
  className?: string;
  children: React.ReactNode[];
}

/**
 * Walk placeholder-bearing text + skeleton and return a React tree.
 *
 * Returns `null` for empty input (the caller decides how to indicate
 * "no translatable content").
 *
 * Pass `image_resolver` to opt-in to inline image rendering; when
 * unset, image tokens render as the legacy `[image: filename]` text
 * marker (preserves existing behaviour for non-Reader call sites).
 */
export function renderPreview(
  text: string,
  skeleton: readonly InlineToken[],
  image_resolver?: ImageResolver,
): React.ReactNode {
  if (!text) return null;
  const root: Frame = { idx: -1, el: null, children: [] };
  const stack: Frame[] = [root];

  // PLACEHOLDER_RE is exported as a global RegExp. Re-create per-call
  // so concurrent renderers can't fight over `.lastIndex`.
  const re = new RegExp(PLACEHOLDER_RE.source, PLACEHOLDER_RE.flags);
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > pos) {
      const top = stack[stack.length - 1];
      top.children.push(text.slice(pos, m.index));
    }
    const isClose = m[1] === "/";
    const idx = Number(m[2]);
    pos = m.index + m[0].length;
    if (idx < 0 || idx >= skeleton.length) {
      stack[stack.length - 1].children.push(
        <span className="text-muted-foreground" key={`bad-${m.index}`}>
          ⟪?⟫
        </span>,
      );
      continue;
    }
    const token = skeleton[idx];
    if (token.kind === "void") {
      const node = voidMarker(token, image_resolver);
      if (node !== null) {
        stack[stack.length - 1].children.push(
          <React.Fragment key={`v-${m.index}`}>{node}</React.Fragment>,
        );
      }
      continue;
    }
    if (token.kind === "entity") {
      stack[stack.length - 1].children.push(
        <React.Fragment key={`e-${m.index}`}>{entityMarker(token)}</React.Fragment>,
      );
      continue;
    }
    if (isClose) {
      // Pop frames until we find one matching the index. If no match
      // (skeleton mismatch) we drop the close silently — the validator
      // is the authoritative gate; the preview's job is to never crash.
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].idx === idx) {
          const closed = stack.pop()!;
          const parent = stack[stack.length - 1];
          parent.children.push(buildElement(closed, m.index));
          break;
        }
      }
      continue;
    }
    const wrap = wrapFor(token.tag);
    stack.push({ idx, el: wrap.el, className: wrap.className, children: [] });
  }
  if (pos < text.length) {
    stack[stack.length - 1].children.push(text.slice(pos));
  }
  // Close any open frames (malformed placeholder pairs in the source).
  while (stack.length > 1) {
    const closed = stack.pop()!;
    const parent = stack[stack.length - 1];
    parent.children.push(buildElement(closed, text.length));
  }
  return <>{root.children}</>;
}

function buildElement(frame: Frame, marker: number): React.ReactNode {
  const key = `f-${frame.idx}-${marker}`;
  if (frame.el === null) {
    return <React.Fragment key={key}>{frame.children}</React.Fragment>;
  }
  return React.createElement(
    frame.el,
    { key, className: frame.className },
    ...frame.children,
  );
}

/** True iff `text` contains anything beyond placeholders / whitespace. */
export function hasTranslatableText(text: string): boolean {
  if (!text) return false;
  const re = new RegExp(PLACEHOLDER_RE.source, PLACEHOLDER_RE.flags);
  return text.replace(re, "").trim().length > 0;
}

/** Compact, plain-text preview for dense list cells. */
export function compactPreview(text: string, width = 60): string {
  if (!text) return "";
  const re = new RegExp(PLACEHOLDER_RE.source, PLACEHOLDER_RE.flags);
  const flat = text.replace(re, "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (flat.length <= width) return flat;
  return `${flat.slice(0, width - 1)}\u2026`;
}
