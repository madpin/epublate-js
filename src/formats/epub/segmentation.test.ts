/**
 * Tests for placeholderize / applyParts / hoistOrphanedInlineRuns.
 *
 * The big property-based round-trip test (load → segment → reassemble
 * → save → re-load → identical chapter trees) lives in
 * `epub.test.ts`. This file pins the behaviour of the segmentation
 * primitives in isolation so failures here don't get drowned out by
 * loader/writer noise.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  applyParts,
  countTokens,
  findTranslatableHosts,
  hoistOrphanedInlineRuns,
  isTriviallyEmpty,
  placeholderize,
  splitBySentences,
  validateSegmentPlaceholders,
} from "./segmentation";
import type { InlineToken, Segment } from "./types";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

function parse(xml: string): Element {
  const doc = new DOMParser().parseFromString(xml, "application/xhtml+xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error(`parse failed: ${xml}`);
  }
  return doc.documentElement;
}

function serializeChildren(host: Element): string {
  let out = "";
  for (let n = host.firstChild; n !== null; n = n.nextSibling) {
    if (n.nodeType === Node.TEXT_NODE) out += (n as Text).data;
    else if (n.nodeType === Node.ELEMENT_NODE) {
      out += new XMLSerializer().serializeToString(n);
    }
  }
  return out;
}

describe("placeholderize / applyParts identity", () => {
  it("survives a flat paragraph", () => {
    const root = parse(`<p xmlns="${XHTML_NS}">hello world</p>`);
    const before = serializeChildren(root);
    const { source_text, skeleton } = placeholderize(root);
    expect(source_text).toBe("hello world");
    expect(skeleton).toEqual([]);
    applyParts(root, [[source_text, skeleton]]);
    expect(serializeChildren(root)).toBe(before);
  });

  it("captures a single pair", () => {
    const root = parse(`<p xmlns="${XHTML_NS}">say <em>hello</em> world</p>`);
    const { source_text, skeleton } = placeholderize(root);
    expect(source_text).toBe("say [[T0]]hello[[/T0]] world");
    expect(skeleton).toHaveLength(1);
    expect(skeleton[0].kind).toBe("pair");
    expect(skeleton[0].tag).toContain("em");
    applyParts(root, [[source_text, skeleton]]);
    expect(root.textContent).toBe("say hello world");
    const em = root.getElementsByTagName("em")[0];
    expect(em.textContent).toBe("hello");
  });

  it("captures a void element with attributes", () => {
    const root = parse(
      `<p xmlns="${XHTML_NS}">line one<br class="x"/>line two</p>`,
    );
    const { source_text, skeleton } = placeholderize(root);
    expect(source_text).toBe("line one[[T0]]line two");
    expect(skeleton).toHaveLength(1);
    expect(skeleton[0].kind).toBe("void");
    expect(skeleton[0].attrs.class).toBe("x");
    applyParts(root, [[source_text, skeleton]]);
    const br = root.getElementsByTagName("br")[0];
    expect(br).toBeTruthy();
    expect(br.getAttribute("class")).toBe("x");
  });

  it("nests pair tokens", () => {
    const root = parse(
      `<p xmlns="${XHTML_NS}">A<span>B<em>C</em>D</span>E</p>`,
    );
    const before = serializeChildren(root);
    const { source_text, skeleton } = placeholderize(root);
    expect(source_text).toBe("A[[T0]]B[[T1]]C[[/T1]]D[[/T0]]E");
    applyParts(root, [[source_text, skeleton]]);
    expect(serializeChildren(root)).toBe(before);
  });

  it("survives translated body identity by token replacement", () => {
    const root = parse(`<p xmlns="${XHTML_NS}">say <em>hello</em></p>`);
    const { source_text, skeleton } = placeholderize(root);
    const target = source_text.replace("say", "diga").replace("hello", "olá");
    applyParts(root, [[target, skeleton]]);
    expect(root.textContent).toBe("diga olá");
    expect(root.getElementsByTagName("em")[0].textContent).toBe("olá");
  });
});

describe("placeholderize / applyParts property-based identity", () => {
  // Build random XHTML trees made of nested phrasing elements + text and
  // verify `apply(placeholder(host)) == host`.
  const TAGS = ["em", "strong", "span", "a", "i", "b"] as const;

  type Node = string | { tag: (typeof TAGS)[number]; children: Node[] };

  const treeArb: fc.Arbitrary<Node[]> = fc.letrec((tie) => ({
    leaf: fc.string({ minLength: 1, maxLength: 5 }).map((s) =>
      // strip `<` and `>` so we don't accidentally produce parser-fooling text
      s.replace(/[<>&]/g, "").replace(/\[/g, "").replace(/\]/g, ""),
    ),
    nodeMaybe: fc.oneof(
      { withCrossShrink: true },
      tie("leaf"),
      fc.record({
        tag: fc.constantFrom(...TAGS),
        children: fc.array(tie("nodeMaybe") as fc.Arbitrary<Node>, {
          maxLength: 3,
        }),
      }),
    ),
    nodeList: fc.array(tie("nodeMaybe") as fc.Arbitrary<Node>, {
      minLength: 1,
      maxLength: 4,
    }),
  })).nodeList;

  function render(nodes: Node[]): string {
    return nodes
      .map((n) =>
        typeof n === "string"
          ? n
          : `<${n.tag}>${render(n.children)}</${n.tag}>`,
      )
      .join("");
  }

  it("apply ∘ placeholder is identity for random inline trees", () => {
    fc.assert(
      fc.property(treeArb, (nodes) => {
        const xml = render(nodes);
        if (!xml || /^\s*$/.test(xml)) return; // skip empties
        const root = parse(`<p xmlns="${XHTML_NS}">${xml}</p>`);
        const before = serializeChildren(root);
        const { source_text, skeleton } = placeholderize(root);
        applyParts(root, [[source_text, skeleton]]);
        const after = serializeChildren(root);
        expect(after).toBe(before);
      }),
      { numRuns: 80 },
    );
  });
});

describe("validateSegmentPlaceholders", () => {
  function makeSeg(
    source_text: string,
    skeleton: InlineToken[],
    target_text: string | null = null,
  ): Segment {
    return {
      id: "seg",
      chapter_id: "chap",
      idx: 0,
      source_text,
      source_hash: "h",
      target_text,
      inline_skeleton: skeleton,
      host_path: "/p[1]",
      host_part: 0,
      host_total_parts: 1,
    };
  }
  const pair: InlineToken = { tag: "em", kind: "pair", attrs: {} };
  const voidTok: InlineToken = { tag: "br", kind: "void", attrs: {} };

  it("accepts a balanced source", () => {
    expect(() =>
      validateSegmentPlaceholders(makeSeg("[[T0]]a[[/T0]]", [pair])),
    ).not.toThrow();
  });

  it("rejects missing close", () => {
    expect(() =>
      validateSegmentPlaceholders(makeSeg("[[T0]]a", [pair])),
    ).toThrow(/missing|matched/);
  });

  it("rejects close-without-open", () => {
    expect(() =>
      validateSegmentPlaceholders(makeSeg("[[/T0]]a", [pair])),
    ).toThrow(/once-and-only-once|without opener/);
  });

  it("rejects duplicate void", () => {
    expect(() =>
      validateSegmentPlaceholders(makeSeg("[[T0]][[T0]]", [voidTok])),
    ).toThrow(/missing or duplicated/);
  });
});

describe("isTriviallyEmpty + countTokens", () => {
  it("marks pure whitespace as empty", () => {
    expect(isTriviallyEmpty("")).toBe(true);
    expect(isTriviallyEmpty("   \u00a0\t")).toBe(true);
    expect(isTriviallyEmpty("[[T0]]\u00a0[[/T0]]")).toBe(true);
  });
  it("keeps real prose", () => {
    expect(isTriviallyEmpty("hello")).toBe(false);
  });
  it("countTokens monotonic-ish", () => {
    expect(countTokens("")).toBeGreaterThanOrEqual(1);
    expect(countTokens("a".repeat(40))).toBeGreaterThanOrEqual(10);
  });
});

describe("findTranslatableHosts", () => {
  it("finds inner block hosts only", () => {
    const root = parse(
      `<html xmlns="${XHTML_NS}">
        <body>
          <p>one</p>
          <div>
            <p>two</p>
            <p>three</p>
          </div>
        </body>
      </html>`,
    );
    const hosts = findTranslatableHosts(root);
    const tags = hosts.map((h) => h.localName);
    expect(tags).toContain("p");
    // outer <div> contains block hosts so it's skipped
    expect(tags.filter((t) => t === "div")).toHaveLength(0);
  });

  it("skips code/pre subtrees", () => {
    const root = parse(
      `<html xmlns="${XHTML_NS}"><body><pre><p>x</p></pre><p>y</p></body></html>`,
    );
    const hosts = findTranslatableHosts(root);
    expect(hosts.map((h) => h.textContent?.trim())).toEqual(["y"]);
  });
});

describe("hoistOrphanedInlineRuns", () => {
  it("wraps mixed-content blocks in synthetic divs", () => {
    const root = parse(
      `<html xmlns="${XHTML_NS}"><body><div class="c"><span>orphan text</span><div><p>nested</p></div></div></body></html>`,
    );
    const inserted = hoistOrphanedInlineRuns(root);
    expect(inserted).toBeGreaterThanOrEqual(1);
    const wrappers = root.querySelectorAll('div[data-epublate-orphan="1"]');
    expect(wrappers.length).toBeGreaterThanOrEqual(1);
    // Idempotent
    const inserted2 = hoistOrphanedInlineRuns(root);
    expect(inserted2).toBe(0);
  });

  it("preserves empty inline anchors carrying ids (regression)", () => {
    // Real-world Project Gutenberg pattern: a chapter has a `<div>`
    // whose first child is an empty `<span>` containing a page-number
    // anchor `<a id="page_v"/>`. Sibling block elements like `<h1>`
    // and `<table>` follow. Before the fix `flushInline` looked only
    // at `textContent` and dropped the anchor run because it had no
    // text; epubcheck then complained about a fragment identifier
    // pointing at the missing `id`. The anchor MUST round-trip.
    const root = parse(
      `<html xmlns="${XHTML_NS}"><body><div class="blk"><span class="pageno"><a id="page_v"/></span><h1>Title</h1><p>by author</p><table><tr><td>x</td></tr></table></div></body></html>`,
    );
    hoistOrphanedInlineRuns(root);
    expect(root.querySelector("#page_v")).not.toBeNull();
  });

  it("treats `<table>` as block-like, not as inline content", () => {
    // Without recognising `<table>` as a block-level wrapper,
    // `isMixedContentBlock` would mistake a parent `<div>` containing
    // `<h1>` + `<table>` for a mixed-content host and let the orphan
    // splitter scramble the tree. We need it to leave such structures
    // alone so the writer round-trips them verbatim.
    const root = parse(
      `<html xmlns="${XHTML_NS}"><body><div class="wrap"><h1>Title</h1><table><tr><td>cell</td></tr></table></div></body></html>`,
    );
    hoistOrphanedInlineRuns(root);
    const wrap = root.querySelector("div.wrap");
    expect(wrap).not.toBeNull();
    expect(wrap!.querySelectorAll('div[data-epublate-orphan="1"]').length).toBe(
      0,
    );
  });
});

describe("splitBySentences", () => {
  it("returns one chunk when under budget", () => {
    const out = splitBySentences("short", [], { max_tokens: 100 });
    expect(out).toHaveLength(1);
    expect(out[0].source_text).toBe("short");
  });
  it("splits at sentence boundary, no placeholder midcut", () => {
    const long =
      "First sentence here. Second sentence is also long. Third one wraps it up.";
    const out = splitBySentences(long, [], { max_tokens: 5 });
    expect(out.length).toBeGreaterThan(1);
    // No piece has a dangling placeholder.
    for (const chunk of out) expect(chunk.source_text).not.toMatch(/\[\[T\d+\]\][^\[]*$/);
  });
});
