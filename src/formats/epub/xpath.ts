/**
 * Positional XPath generator + evaluator (browser port of `lxml.getpath`).
 *
 * Why our own dialect rather than `document.evaluate` round-trips:
 *   - lxml's `getpath` produces paths with namespace-prefix-aware indices;
 *     reproducing that exactly in browser XPath is awkward because XPath
 *     1.0 doesn't have namespace defaulting and the OPF/XHTML namespaces
 *     vary per document.
 *   - Our segments table only needs a stable, deterministic locator per
 *     host element. A path of N integers, each the position-among-same-
 *     local-name siblings, is fully deterministic and doesn't care about
 *     namespaces or prefixes.
 *
 * Format: `/{local}[N]/{local}[N]/...` where `{local}` is the element's
 * local name (no namespace prefix) and `[N]` is the 1-based position
 * among siblings sharing the same local name. Element children only —
 * text/comment/PI nodes are not addressable.
 *
 * Example: `/html[1]/body[1]/p[3]` finds the third `<p>` child of the
 * first body of the first html in the chapter document.
 */

import { EpubFormatError } from "./types";

/**
 * Build a stable path from a chapter root down to `target`.
 *
 * `root` is typically the `<html>` element returned by
 * `Document.documentElement`.
 */
export function getXPath(root: Element, target: Element): string {
  if (target === root) return "/";
  const segments: string[] = [];
  let node: Element | null = target;
  while (node && node !== root) {
    const parent: Element | null = node.parentElement;
    if (!parent) {
      throw new EpubFormatError(
        "getXPath: target is not a descendant of root",
      );
    }
    segments.unshift(buildSegment(parent, node));
    node = parent;
  }
  if (!node) {
    throw new EpubFormatError("getXPath: target is not a descendant of root");
  }
  // Anchor with the root's local name + index 1 so the path is
  // self-describing and survives serialization.
  segments.unshift(`${node.localName}[1]`);
  return "/" + segments.join("/");
}

/** Resolve an XPath previously built by `getXPath` against `root`. */
export function findByXPath(root: Element, xpath: string): Element | null {
  if (xpath === "/") return root;
  if (!xpath.startsWith("/")) {
    throw new EpubFormatError(`findByXPath: not absolute: ${xpath}`);
  }
  const parts = xpath.slice(1).split("/").filter((s) => s.length > 0);
  if (parts.length === 0) return root;
  const [rootSeg, ...rest] = parts;
  const { localName: rootLocal, index: rootIdx } = parseSegment(rootSeg);
  if (root.localName !== rootLocal || rootIdx !== 1) return null;
  let cur: Element = root;
  for (const seg of rest) {
    const { localName, index } = parseSegment(seg);
    let count = 0;
    let found: Element | null = null;
    for (
      let child: Element | null = cur.firstElementChild;
      child !== null;
      child = child.nextElementSibling
    ) {
      if (child.localName === localName) {
        count += 1;
        if (count === index) {
          found = child;
          break;
        }
      }
    }
    if (!found) return null;
    cur = found;
  }
  return cur;
}

function buildSegment(parent: Element, child: Element): string {
  const localName = child.localName;
  let index = 0;
  for (
    let s: Element | null = parent.firstElementChild;
    s !== null;
    s = s.nextElementSibling
  ) {
    if (s.localName === localName) {
      index += 1;
      if (s === child) return `${localName}[${index}]`;
    }
  }
  throw new EpubFormatError("buildSegment: child not in parent");
}

const SEG_RE = /^([^[\]]+)\[(\d+)\]$/;

function parseSegment(seg: string): { localName: string; index: number } {
  const match = SEG_RE.exec(seg);
  if (!match) {
    throw new EpubFormatError(`xpath segment malformed: ${seg}`);
  }
  return { localName: match[1], index: Number.parseInt(match[2], 10) };
}
