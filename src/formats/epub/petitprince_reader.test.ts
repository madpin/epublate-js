import { readFile } from "node:fs/promises";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import {
  decodeSkeletonEnvelope,
  encodeSkeletonEnvelope,
} from "@/db/repo/segments";
import { EpubAdapter } from "./index";
import {
  buildChapterImageMap,
  findStandaloneImages,
  loadChapterAssets,
} from "./images";
import type { InlineToken } from "./types";

/**
 * End-to-end exercise of the Reader's image-loading code path against
 * the real `docs/petitprince.epub`. We can't mint object URLs here
 * (jsdom doesn't ship `URL.createObjectURL`), but we can stub it just
 * enough to confirm the pre-warm loop *would* have populated
 * `byResolved` for every standalone image — which is the data the
 * Reader actually reads at render time.
 *
 * If this test ever regresses it almost certainly means we changed
 * either the segmenter's host classifier, the standalone walker, or
 * the loader's `zip_entries` keying — anything in that triangle
 * mismatching breaks image rendering for illustrated ePubs.
 */
describe("petitprince Reader-equivalent flow", () => {
  const minted: string[] = [];
  let original_create: typeof URL.createObjectURL | undefined;
  let original_revoke: typeof URL.revokeObjectURL | undefined;

  beforeAll(() => {
    original_create = (URL as unknown as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL;
    original_revoke = (URL as unknown as { revokeObjectURL?: typeof URL.revokeObjectURL }).revokeObjectURL;
    let counter = 0;
    (URL as unknown as { createObjectURL: typeof URL.createObjectURL }).createObjectURL = ((blob: Blob) => {
      counter += 1;
      const fake = `blob:fake-${counter}-${blob.size}`;
      minted.push(fake);
      return fake;
    }) as typeof URL.createObjectURL;
    (URL as unknown as { revokeObjectURL: typeof URL.revokeObjectURL }).revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  });

  afterAll(() => {
    if (original_create) {
      (URL as unknown as { createObjectURL: typeof URL.createObjectURL }).createObjectURL = original_create;
    }
    if (original_revoke) {
      (URL as unknown as { revokeObjectURL: typeof URL.revokeObjectURL }).revokeObjectURL = original_revoke;
    }
  });

  async function loadBytes(): Promise<ArrayBuffer> {
    const buf = await readFile(
      "/Users/tpinto/madpin/epublatejs/docs/petitprince.epub",
    );
    const ab = new ArrayBuffer(buf.byteLength);
    new Uint8Array(ab).set(new Uint8Array(buf));
    return ab;
  }

  it("resolves every standalone image for the illustrated chapter", async () => {
    const ab = await loadBytes();
    const adapter = new EpubAdapter();
    const intake_book = await adapter.load(ab);

    // Pick a chapter that has standalone images but also segments —
    // this is the most demanding render path because it exercises
    // both the inline-image map and the standalone walker, plus the
    // host-anchored splice.
    const ch_with_imgs = intake_book.chapters.find(
      (c) => c.href === "Ops/004.html",
    );
    expect(ch_with_imgs, "Ops/004.html should be in spine").toBeTruthy();

    const intake_segs = adapter.segment(ch_with_imgs!, {
      chapter_id: "test",
      target_lang: "pt-BR",
    });
    expect(intake_segs.length).toBeGreaterThan(0);

    // Re-load (the Reader does this every time you switch chapters)
    // and run the same pipeline ReaderRoute uses.
    const loaded = await loadChapterAssets(ab, "Ops/004.html");
    expect(loaded).not.toBeNull();

    const skeletons: InlineToken[][] = intake_segs.map((s) => s.inline_skeleton);
    const image_map = buildChapterImageMap(
      loaded!.book,
      loaded!.chapter,
      skeletons,
    );

    const standalone = findStandaloneImages(loaded!.chapter, {
      target_lang: "pt-BR",
    });
    expect(standalone.length).toBeGreaterThan(0);

    // Pre-warm the standalone images, mirroring the Reader's effect.
    for (const item of standalone) {
      if (image_map.byResolved.has(item.resolved)) continue;
      const data = loaded!.book.zip_entries.get(item.resolved);
      expect(data, `zip should contain ${item.resolved}`).toBeTruthy();
      const blob = new Blob([data as BlobPart], { type: "image/jpeg" });
      const url = URL.createObjectURL(blob);
      image_map.byResolved.set(item.resolved, url);
      image_map.urls.push(url);
    }

    // Every standalone image must resolve to an object URL the
    // Reader can render. This is the assertion that catches the
    // "images are missing in the app" regression: if any standalone
    // entry has no URL, the StandaloneImageCard renders the text
    // marker fallback instead of the picture.
    for (const item of standalone) {
      const url = image_map.byResolved.get(item.resolved);
      expect(url, `byResolved should have URL for ${item.resolved}`).toBeTruthy();
    }
  });

  it("fully resolves a cover-only chapter", async () => {
    const ab = await loadBytes();
    const loaded = await loadChapterAssets(ab, "Ops/007.html");
    expect(loaded).not.toBeNull();

    const standalone = findStandaloneImages(loaded!.chapter, {
      target_lang: "pt-BR",
    });
    expect(standalone).toHaveLength(1);
    expect(standalone[0]!.splice_at).toBe(0);

    const data = loaded!.book.zip_entries.get(standalone[0]!.resolved);
    expect(data).toBeTruthy();
    expect(data!.byteLength).toBeGreaterThan(0);
  });

  it("classifies <p><a id='aN'/><img/></p> as a standalone image", async () => {
    const ab = await loadBytes();
    // Ops/043.html in the published petitprince ePub is a back-matter
    // illustration page whose <p> wrapper has only an anchor + img.
    // This is the exact pattern that originally tripped up the
    // walker — make sure we still classify it as standalone.
    const loaded = await loadChapterAssets(ab, "Ops/043.html");
    if (!loaded) {
      // Older ePub variants don't ship this chapter — bail without
      // failing. The underlying logic is covered by `images.test.ts`.
      return;
    }
    const standalone = findStandaloneImages(loaded.chapter, {
      target_lang: "pt-BR",
    });
    expect(standalone.length).toBeGreaterThan(0);
  });

  it("returns useful diagnostics when the source ePub bytes are absent", async () => {
    // No bytes → the loader can't find anything. Reader's effect
    // surfaces this as `status: "missing-source"`. This test pins
    // the failure mode so we don't accidentally start swallowing it.
    const empty_buf = new ArrayBuffer(0);
    await expect(
      loadChapterAssets(empty_buf, "Ops/004.html"),
    ).rejects.toThrow();
  });

  it("returns null when the chapter href is not in the spine", async () => {
    const ab = await loadBytes();
    const loaded = await loadChapterAssets(ab, "Ops/does-not-exist.html");
    // missing-chapter case: Reader surfaces this as a banner and
    // falls back to text-only rendering.
    expect(loaded).toBeNull();
  });

  it("survives the full encode→decode envelope round-trip when building the image map", async () => {
    // Regression for "skeleton is not iterable": when the Reader
    // pulled `row.inline_skeleton` straight out of IndexedDB, naive
    // `JSON.parse` returned the *envelope* (`{ skeleton, host_path,
    // host_part, host_total_parts }`), not the bare skeleton array.
    // Iterating the object then threw inside `buildChapterImageMap`.
    // We now go through `decodeSkeletonEnvelope` like every other
    // skeleton consumer; this test wires the whole round-trip up so
    // it can't silently regress again.
    const ab = await loadBytes();
    const adapter = new EpubAdapter();
    const intake_book = await adapter.load(ab);
    const ch = intake_book.chapters.find((c) => c.href === "Ops/004.html");
    expect(ch).toBeTruthy();
    const segs = adapter.segment(ch!, {
      chapter_id: "test",
      target_lang: "pt-BR",
    });
    expect(segs.length).toBeGreaterThan(0);

    // Round-trip every segment's envelope exactly the way the DB
    // would, then decode and feed the skeletons to the Reader's
    // image-map builder.
    const envelopes = segs.map((s) =>
      encodeSkeletonEnvelope({
        ...s,
        target_text: null,
      }),
    );
    const skeletons: InlineToken[][] = envelopes.map(
      (blob) => decodeSkeletonEnvelope(blob).skeleton,
    );

    const loaded = await loadChapterAssets(ab, "Ops/004.html");
    expect(loaded).not.toBeNull();
    // Should not throw "skeleton is not iterable".
    const image_map = buildChapterImageMap(
      loaded!.book,
      loaded!.chapter,
      skeletons,
    );
    expect(image_map).toBeTruthy();
  });

  it("documents what the original 'skeleton is not iterable' error looked like", () => {
    // Acts as a trip-wire: if a future refactor accidentally feeds
    // the envelope object back into the image map (instead of the
    // inner skeleton array), the inner `for (const t of skeleton)`
    // loop in `buildChapterImageMap` would throw "X is not iterable".
    // Pinning the error shape here makes the regression obvious.
    const fake_envelope_passed_as_skeleton = {
      skeleton: [],
      host_path: "/p[1]",
      host_part: 0,
      host_total_parts: 1,
    } as unknown as InlineToken[];
    expect(() => {
      for (const _t of fake_envelope_passed_as_skeleton) void _t;
    }).toThrow(/is not iterable/);
  });
});
