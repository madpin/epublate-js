/**
 * Reversible XHTML ↔ placeholder-text conversion.
 *
 * Direct port of `epublate.core.segmentation`. The hard rules:
 *
 *   1. `applyParts(host, [placeholderize(host)])` is identity on the
 *      host's serialized form. Property-tested with fast-check.
 *   2. Every placeholder issued in the source must appear *exactly
 *      once* in the target; pair tokens get matched openers/closers,
 *      void/entity tokens stand alone. Mismatch → `EpubFormatError`.
 *   3. Sentence splits never land inside an open placeholder pair.
 *
 * Notes specific to the browser port:
 *
 *   - lxml's "Clark notation" (`{ns}local`) lives on as
 *     `InlineToken.tag`, but DOM never gives us that string directly.
 *     We synthesize it from `namespaceURI` + `localName` for
 *     consistency with skeleton blobs that may have been authored on
 *     the Python side.
 *   - DOM has no `Entity` node type after parsing — `expandNamedEntities`
 *     has already flattened those to literal Unicode characters.
 *     `entity` tokens therefore only appear when round-tripping a
 *     skeleton that came from the Python tool; we still rebuild them
 *     using `Document.createEntityReference` when the platform supports
 *     it, falling back to literal text otherwise.
 */

import {
  EpubFormatError,
  type InlineToken,
  type Segment,
} from "./types";

export const PLACEHOLDER_RE = /\[\[(\/?)T(\d+)\]\]/g;

const INVISIBLE_FORMATTING_RE = /[\u200b\u200c\u200d\u2060\ufeff]/g;

export const VOID_LOCAL_NAMES: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export const BLOCK_HOST_TAGS: ReadonlySet<string> = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "td",
  "th",
  "figcaption",
  "blockquote",
  "dt",
  "dd",
  "caption",
  "div",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "main",
]);

export const PHRASING_ONLY_BLOCK_HOSTS: ReadonlySet<string> = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "dt",
]);

const SKIP_TAGS: ReadonlySet<string> = new Set([
  "code",
  "pre",
  "script",
  "style",
]);

/** Cheap, deterministic chars/4 estimate. Real tokenizer wired in P2. */
export function countTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4));
}

/**
 * True iff `source_text` is purely whitespace + placeholders + zero-width
 * formatting. Skip-empty is a defense-in-depth against `<p>&nbsp;</p>`
 * separators bloating the segment table.
 */
export function isTriviallyEmpty(source_text: string): boolean {
  if (!source_text) return true;
  const stripped = source_text
    .replace(PLACEHOLDER_RE, "")
    .replace(INVISIBLE_FORMATTING_RE, "")
    .trim();
  return stripped.length === 0;
}

function clarkTag(elem: Element): string {
  const ns = elem.namespaceURI;
  if (!ns) return elem.localName;
  return `{${ns}}${elem.localName}`;
}

function isVoidElement(elem: Element): boolean {
  return VOID_LOCAL_NAMES.has(elem.localName.toLowerCase());
}

/**
 * Convert a block-level element's *inner* content to placeholder text.
 * The host element itself is unchanged.
 */
export function placeholderize(
  host: Element,
): { source_text: string; skeleton: InlineToken[] } {
  const parts: string[] = [];
  const skeleton: InlineToken[] = [];

  for (
    let node: Node | null = host.firstChild;
    node !== null;
    node = node.nextSibling
  ) {
    emitNode(node, parts, skeleton);
  }

  return { source_text: parts.join(""), skeleton };
}

function emitNode(
  node: Node,
  parts: string[],
  skeleton: InlineToken[],
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    parts.push((node as Text).data);
    return;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    emitElement(node as Element, parts, skeleton);
    return;
  }
  if (node.nodeType === Node.CDATA_SECTION_NODE) {
    parts.push((node as CDATASection).data);
    return;
  }
  // Comments, processing instructions: dropped (mirrors Python).
}

function emitElement(
  elem: Element,
  parts: string[],
  skeleton: InlineToken[],
): void {
  const my_idx = skeleton.length;
  const tag = clarkTag(elem);
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(elem.attributes)) {
    attrs[attr.name] = attr.value;
  }

  if (isVoidElement(elem)) {
    skeleton.push({ tag, kind: "void", attrs });
    parts.push(`[[T${my_idx}]]`);
    return;
  }

  skeleton.push({ tag, kind: "pair", attrs });
  parts.push(`[[T${my_idx}]]`);
  for (
    let child: Node | null = elem.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    emitNode(child, parts, skeleton);
  }
  parts.push(`[[/T${my_idx}]]`);
}

export type Part = readonly [source_text: string, skeleton: readonly InlineToken[]];

/**
 * Replace the host's contents with one or more `(text, skeleton)` parts.
 * Each part's placeholders resolve only against its own skeleton.
 */
export function applyParts(host: Element, parts: ReadonlyArray<Part>): void {
  while (host.firstChild) host.removeChild(host.firstChild);

  const owner = host.ownerDocument;
  if (!owner) {
    throw new EpubFormatError("applyParts: host has no ownerDocument");
  }

  // Stack of currently-open elements, [host, ...openPairs].
  const stack: Element[] = [host];
  // Where the next text run goes:
  //   - When stack length > 1 and the most recently appended element
  //     is the top of the stack, target = (top, "text").
  //   - After a child is appended (and not pushed for opening), target
  //     = (child, "tail-as-text-after").
  // DOM doesn't have "tail" per lxml; we model it by tracking the
  // *last appended child of the current open scope* and appending text
  // nodes after it.
  let last_appended: Element | null = null;

  const appendText = (s: string): void => {
    if (s.length === 0) return;
    const top = stack[stack.length - 1];
    if (last_appended) {
      // Insert text after `last_appended` inside `top`.
      const text_node = owner.createTextNode(s);
      top.insertBefore(text_node, last_appended.nextSibling);
    } else {
      top.appendChild(owner.createTextNode(s));
    }
  };

  const append_element = (el: Element): void => {
    const top = stack[stack.length - 1];
    top.appendChild(el);
    last_appended = el;
  };

  for (const [source_text, skeleton] of parts) {
    let pos = 0;
    PLACEHOLDER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PLACEHOLDER_RE.exec(source_text)) !== null) {
      const text_before = source_text.slice(pos, m.index);
      if (text_before) appendText(text_before);
      const is_close = m[1] === "/";
      const tok_idx = Number.parseInt(m[2], 10);
      if (tok_idx < 0 || tok_idx >= skeleton.length) {
        throw new EpubFormatError(
          `placeholder index ${tok_idx} has no matching skeleton entry`,
        );
      }
      const token = skeleton[tok_idx];
      if (is_close) {
        if (stack.length <= 1) {
          throw new EpubFormatError(
            `closing placeholder [[/T${tok_idx}]] without an open pair`,
          );
        }
        const closed = stack.pop()!;
        last_appended = closed;
      } else if (token.kind === "entity") {
        // Browsers cannot recreate true entity-reference nodes after
        // parsing, so we emit a literal placeholder element marked
        // with the entity name as `data-epublate-entity`. The writer
        // can then decide to serialize it as `&name;` if we're
        // re-emitting raw bytes (we currently don't, but the option
        // is preserved for a future strict-entity mode).
        const name = token.attrs["name"] ?? token.tag.replace(/^&|;$/g, "");
        const expansion = TEXT_ENTITY_EXPANSIONS[name];
        if (expansion !== undefined) {
          appendText(expansion);
        } else {
          appendText(name); // best-effort fallback
        }
      } else {
        const new_elem = createSubElement(owner, token);
        append_element(new_elem);
        if (token.kind === "pair") {
          stack.push(new_elem);
          last_appended = null;
        }
      }
      pos = m.index + m[0].length;
    }
    const text_after = source_text.slice(pos);
    if (text_after) appendText(text_after);
  }

  if (stack.length > 1) {
    const unclosed = stack.slice(1).map((e) => e.localName).join(", ");
    throw new EpubFormatError(`placeholder text left open pairs: ${unclosed}`);
  }
}

function createSubElement(
  owner: Document,
  token: InlineToken,
): Element {
  let elem: Element;
  if (token.tag.startsWith("{")) {
    const close = token.tag.indexOf("}");
    const ns = token.tag.slice(1, close);
    const local = token.tag.slice(close + 1);
    elem = owner.createElementNS(ns, local);
  } else {
    // No namespace declared. Inheriting it from the parent would force
    // an explicit `xmlns=""` reset on serialization; keep it nameless.
    elem = owner.createElementNS(null, token.tag);
  }
  for (const [k, v] of Object.entries(token.attrs)) {
    elem.setAttribute(k, v);
  }
  return elem;
}

// Re-export so callers don't have to know about the entities module's
// existence. The two strings live on opposite sides of the
// segmentation API but are conceptually one feature.
import { TEXT_ENTITY_EXPANSIONS } from "./text_entities";

/**
 * Restore leading / trailing whitespace the LLM stripped from `target`.
 *
 * OpenAI-compatible chat endpoints typically `.strip()` the response;
 * the lost whitespace is purely cosmetic but the source ePub's
 * per-host indentation is part of its identity, so re-introducing it
 * keeps diffs against the original small.
 */
export function restoreOuterWhitespace(
  source_text: string,
  target_text: string,
): string {
  if (!source_text || !target_text) return target_text;
  const src_lead = source_text.length - source_text.trimStart().length;
  const src_trail = source_text.length - source_text.trimEnd().length;
  const tgt_lead = target_text.length - target_text.trimStart().length;
  const tgt_trail = target_text.length - target_text.trimEnd().length;
  let out = target_text;
  if (src_lead && !tgt_lead) {
    out = source_text.slice(0, src_lead) + out;
  }
  if (src_trail && !tgt_trail) {
    out = out + source_text.slice(source_text.length - src_trail);
  }
  return out;
}

/**
 * Validate that a segment's placeholders match its skeleton (mirrors
 * `epublate.core.validators.validate_segment_placeholders`).
 */
export function validateSegmentPlaceholders(seg: Segment): void {
  const text = seg.target_text ?? seg.source_text;
  const open_counts = new Map<number, number>();
  const close_counts = new Map<number, number>();
  const void_counts = new Map<number, number>();

  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    const idx = Number.parseInt(m[2], 10);
    if (idx < 0 || idx >= seg.inline_skeleton.length) {
      throw new EpubFormatError(
        `segment ${seg.id}: placeholder [[T${idx}]] has no skeleton entry`,
      );
    }
    const is_close = m[1] === "/";
    const token = seg.inline_skeleton[idx];
    if (token.kind === "void" || token.kind === "entity") {
      if (is_close) {
        throw new EpubFormatError(
          `segment ${seg.id}: ${token.kind} placeholder [[/T${idx}]] cannot close`,
        );
      }
      void_counts.set(idx, (void_counts.get(idx) ?? 0) + 1);
    } else if (is_close) {
      close_counts.set(idx, (close_counts.get(idx) ?? 0) + 1);
    } else {
      open_counts.set(idx, (open_counts.get(idx) ?? 0) + 1);
    }
  }

  seg.inline_skeleton.forEach((token, idx) => {
    if (token.kind === "void" || token.kind === "entity") {
      if ((void_counts.get(idx) ?? 0) !== 1) {
        throw new EpubFormatError(
          `segment ${seg.id}: ${token.kind} placeholder [[T${idx}]] missing or duplicated`,
        );
      }
    } else {
      if (
        (open_counts.get(idx) ?? 0) !== 1 ||
        (close_counts.get(idx) ?? 0) !== 1
      ) {
        throw new EpubFormatError(
          `segment ${seg.id}: placeholder [[T${idx}]] is not matched once-and-only-once`,
        );
      }
    }
  });

  for (const idx of close_counts.keys()) {
    if (!open_counts.has(idx)) {
      throw new EpubFormatError(
        `segment ${seg.id}: closing placeholder [[/T${idx}]] without opener`,
      );
    }
  }
}

/**
 * Walk the chapter tree top-down and return every block-host element
 * we should segment. Mirrors `_find_translatable_hosts`.
 */
export function findTranslatableHosts(
  root: Element,
  options: { target_lang?: string | null } = {},
): Element[] {
  const hosts: Element[] = [];
  const target_lang = options.target_lang ?? null;
  const walker = (root.ownerDocument ?? document).createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT,
  );
  let elem: Element | null = root.localName && BLOCK_HOST_TAGS.has(root.localName.toLowerCase())
    ? root
    : (walker.nextNode() as Element | null);
  while (elem !== null) {
    const local = elem.localName.toLowerCase();
    if (BLOCK_HOST_TAGS.has(local) && !isSkipped(elem) && !hasInnerBlockHost(elem)) {
      if (!target_lang || !matchesLang(elem, target_lang)) {
        hosts.push(elem);
      }
    }
    elem = walker.nextNode() as Element | null;
  }
  return hosts;
}

function isSkipped(elem: Element): boolean {
  if (SKIP_TAGS.has(elem.localName.toLowerCase())) return true;
  for (
    let p: Element | null = elem.parentElement;
    p !== null;
    p = p.parentElement
  ) {
    if (SKIP_TAGS.has(p.localName.toLowerCase())) return true;
  }
  return false;
}

function hasInnerBlockHost(elem: Element): boolean {
  const walker = (elem.ownerDocument ?? document).createTreeWalker(
    elem,
    NodeFilter.SHOW_ELEMENT,
  );
  let cur: Element | null = walker.nextNode() as Element | null;
  while (cur !== null) {
    if (BLOCK_HOST_TAGS.has(cur.localName.toLowerCase())) return true;
    cur = walker.nextNode() as Element | null;
  }
  return false;
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";

function matchesLang(elem: Element, target: string): boolean {
  const want = target.toLowerCase().split("-", 1)[0];
  for (
    let cur: Element | null = elem;
    cur !== null;
    cur = cur.parentElement
  ) {
    const lang = cur.getAttributeNS(XML_NS, "lang") ?? cur.getAttribute("lang");
    if (lang) {
      return lang.toLowerCase().split("-", 1)[0] === want;
    }
  }
  return false;
}

/**
 * Hoist orphaned inline runs in mixed-content blocks (Calibre cleanup).
 * Idempotent: re-running on a tree without mixed-content hosts is a no-op.
 */
export function hoistOrphanedInlineRuns(root: Element): number {
  const candidates: Element[] = [];
  const walker = (root.ownerDocument ?? document).createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT,
  );
  let cur: Element | null = root;
  while (cur !== null) {
    const local = cur.localName.toLowerCase();
    if (BLOCK_HOST_TAGS.has(local) && !isSkipped(cur) && isMixedContentBlock(cur)) {
      candidates.push(cur);
    }
    cur = walker.nextNode() as Element | null;
  }

  let inserted = 0;
  for (const parent of candidates) inserted += splitMixedContentBlock(parent);
  return inserted;
}

/**
 * Block-level wrappers that aren't translatable hosts themselves but
 * should still be considered "block-like" when deciding whether a
 * parent is a mixed-content block. Without this list we end up
 * treating a `<table>` (or `<ul>`, `<figure>`, ...) as inline content
 * inside its parent, then route its text through the orphan-wrapper
 * machinery which stomps on critical sibling elements.
 */
export const BLOCK_OUTER_TAGS: ReadonlySet<string> = new Set([
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "ul",
  "ol",
  "dl",
  "figure",
  "form",
  "hgroup",
  "nav",
  "pre",
]);

function isMixedContentBlock(elem: Element): boolean {
  let has_block = false;
  let has_inline = false;
  for (
    let n: Node | null = elem.firstChild;
    n !== null;
    n = n.nextSibling
  ) {
    if (n.nodeType === Node.TEXT_NODE) {
      if ((n as Text).data.trim().length > 0) has_inline = true;
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const child = n as Element;
      const local = child.localName.toLowerCase();
      if (BLOCK_HOST_TAGS.has(local) || BLOCK_OUTER_TAGS.has(local)) {
        has_block = true;
      } else if ((child.textContent ?? "").trim().length > 0) {
        has_inline = true;
      }
    }
  }
  return has_block && has_inline;
}

function splitMixedContentBlock(parent: Element): number {
  const owner = parent.ownerDocument;
  if (!owner) return 0;
  const children: Node[] = Array.from(parent.childNodes);
  if (children.length === 0) return 0;

  const ns = parent.namespaceURI;
  const parent_class = parent.getAttribute("class");

  const new_top_level: Node[] = [];
  let pending_inlines: Node[] = [];
  let inserted = 0;

  const flushInline = (): void => {
    if (pending_inlines.length === 0) return;
    // Drop the run only when it carries no information at all — pure
    // whitespace text nodes. Any element node, even an empty
    // `<a id="page_v"/>` anchor or a `<span class="page-marker"/>`,
    // is meaningful for navigation/styling and MUST be preserved
    // verbatim in the output. DOM serialization will fold pure
    // whitespace anyway, so dropping that case is safe.
    const has_meaningful = pending_inlines.some((n) => {
      if (n.nodeType === Node.ELEMENT_NODE) return true;
      if (n.nodeType === Node.TEXT_NODE) {
        return (n as Text).data.trim().length > 0;
      }
      return false;
    });
    if (!has_meaningful) {
      pending_inlines = [];
      return;
    }
    const wrapper = ns
      ? owner.createElementNS(ns, "div")
      : owner.createElementNS(null, "div");
    if (parent_class) wrapper.setAttribute("class", parent_class);
    wrapper.setAttribute("data-epublate-orphan", "1");
    for (const n of pending_inlines) wrapper.appendChild(n);
    new_top_level.push(wrapper);
    inserted += 1;
    pending_inlines = [];
  };

  for (const n of children) {
    const is_block =
      n.nodeType === Node.ELEMENT_NODE &&
      (BLOCK_HOST_TAGS.has((n as Element).localName.toLowerCase()) ||
        BLOCK_OUTER_TAGS.has((n as Element).localName.toLowerCase()));
    if (is_block) {
      flushInline();
      new_top_level.push(n);
    } else {
      pending_inlines.push(n);
    }
  }
  flushInline();

  while (parent.firstChild) parent.removeChild(parent.firstChild);
  for (const n of new_top_level) parent.appendChild(n);

  return inserted;
}

/**
 * Split a long source_text into chunks under `max_tokens`. Splits land
 * at sentence boundaries and never inside an open placeholder pair.
 */
export function splitBySentences(
  source_text: string,
  skeleton: ReadonlyArray<InlineToken>,
  options: { max_tokens: number },
): { source_text: string; skeleton: InlineToken[] }[] {
  const { max_tokens } = options;
  if (countTokens(source_text) <= max_tokens) {
    return [{ source_text, skeleton: [...skeleton] }];
  }

  const safe = safeSplitPoints(source_text, skeleton);
  if (safe.length === 0) {
    return [{ source_text, skeleton: [...skeleton] }];
  }

  const pieces: string[] = [];
  let prev = 0;
  for (const sp of safe) {
    if (sp > prev) {
      pieces.push(source_text.slice(prev, sp));
      prev = sp;
    }
  }
  if (prev < source_text.length) pieces.push(source_text.slice(prev));

  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const candidate = current + piece;
    if (current && countTokens(candidate) > max_tokens) {
      chunks.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks.map((c) => renumber(c, skeleton));
}

function safeSplitPoints(
  source_text: string,
  skeleton: ReadonlyArray<InlineToken>,
): number[] {
  const safe: number[] = [];
  let depth = 0;
  let pos = 0;
  const n = source_text.length;
  while (pos < n) {
    PLACEHOLDER_RE.lastIndex = pos;
    const m = PLACEHOLDER_RE.exec(source_text);
    if (m && m.index === pos) {
      const is_close = m[1] === "/";
      const idx = Number.parseInt(m[2], 10);
      const kind =
        idx >= 0 && idx < skeleton.length ? skeleton[idx].kind : "void";
      if (is_close) depth -= 1;
      else if (kind === "pair") depth += 1;
      pos = m.index + m[0].length;
      continue;
    }
    if (depth === 0 && /[.!?]/.test(source_text[pos])) {
      let j = pos + 1;
      while (j < n && /[.!?]/.test(source_text[j])) j += 1;
      if (j < n && /\s/.test(source_text[j])) {
        let k = j;
        while (k < n && /\s/.test(source_text[k])) k += 1;
        safe.push(k);
        pos = k;
        continue;
      }
    }
    pos += 1;
  }
  return safe;
}

function renumber(
  text: string,
  skeleton: ReadonlyArray<InlineToken>,
): { source_text: string; skeleton: InlineToken[] } {
  const seen = new Map<number, number>();
  const used: number[] = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    const old = Number.parseInt(m[2], 10);
    if (!seen.has(old)) {
      seen.set(old, used.length);
      used.push(old);
    }
  }
  const new_text = text.replace(PLACEHOLDER_RE, (_match, slash: string, n: string) => {
    const old = Number.parseInt(n, 10);
    const remapped = seen.get(old);
    if (remapped === undefined) return `[[${slash}T${old}]]`;
    return `[[${slash}T${remapped}]]`;
  });
  return { source_text: new_text, skeleton: used.map((i) => skeleton[i]) };
}
