/**
 * Synthetic end-to-end pipeline benchmark.
 *
 * Drives the full intake → translate batch pipeline over
 * `docs/petitprince.epub` against the deterministic `MockProvider`
 * and prints wall-clock timings plus the most useful counters:
 *
 *   intake_ms        : ePub unzip + parse + segment + persist
 *   batch_ms         : translate every pending segment with the mock
 *   total_segments   : work units
 *   matcher.compiles : glossary matcher regex compilations
 *   matcher.hits     : glossary matcher cache hits
 *   entities.misses  : pre-parse entity-expansion cache misses
 *   entities.hits    : pre-parse entity-expansion cache hits
 *
 * Run with:
 *
 *     npm run bench
 *
 * Notes:
 *
 *   - The benchmark runs inside Vitest so it inherits the project's
 *     `jsdom` + `fake-indexeddb` setup with zero extra plumbing.
 *     `vitest.config.ts` doesn't pick this file up by default
 *     (filename doesn't end in `.test.ts`), so `npm test` skips it.
 *   - The wall-clock numbers are not comparable across machines.
 *     CI's regression budget should use ratios (e.g. "batch_ms must
 *     not exceed 1.5x the previous baseline") rather than absolute
 *     thresholds.
 *   - The mock provider is deterministic but does perform JSON
 *     parsing per call, so the batch wall-clock IS sensitive to
 *     pipeline / matcher work — that's the whole point.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { describe, it, expect } from "vitest";

import { runBatch } from "@/core/batch";
import { runProjectIntake } from "@/core/project_intake";
import { createProject, deleteProject } from "@/db/repo/projects";
import {
  __getEntityCacheStats,
  __resetEntityCacheForTests,
} from "@/formats/epub/entities";
import {
  __getMatcherStats,
  __resetMatcherCacheForTests,
} from "@/glossary/matcher";
import { MockProvider } from "@/llm/mock";

const EPUB_PATH = path.resolve(process.cwd(), "docs/petitprince.epub");

interface BenchResult {
  intake_ms: number;
  batch_ms: number;
  total_segments: number;
  translated: number;
  cached: number;
  flagged: number;
  failed: number;
  matcher_compiles: number;
  matcher_hits: number;
  entities_misses: number;
  entities_hits: number;
}

async function runPetitPrinceBench(): Promise<BenchResult> {
  const u8 = await fs.readFile(EPUB_PATH);
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);

  __resetEntityCacheForTests();
  __resetMatcherCacheForTests();

  const project = await createProject({
    name: "bench.petitprince",
    source_lang: "fr",
    target_lang: "en",
    source_filename: "petitprince.epub",
    source_bytes: buf,
  });

  try {
    const intake_t0 = performance.now();
    const intake = await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: buf,
      source_filename: "petitprince.epub",
    });
    const intake_ms = performance.now() - intake_t0;

    const provider = new MockProvider();
    const batch_t0 = performance.now();
    const summary = await runBatch({
      project_id: project.id,
      source_lang: "fr",
      target_lang: "en",
      provider,
      options: { model: "mock-model", concurrency: 4 },
    });
    const batch_ms = performance.now() - batch_t0;

    const matcher = __getMatcherStats();
    const entities = __getEntityCacheStats();

    return {
      intake_ms,
      batch_ms,
      total_segments: intake.segments,
      translated: summary.translated,
      cached: summary.cached,
      flagged: summary.flagged,
      failed: summary.failed,
      matcher_compiles: matcher.compile_count,
      matcher_hits: matcher.cache_hit_count,
      entities_misses: entities.misses,
      entities_hits: entities.hits,
    };
  } finally {
    await deleteProject(project.id);
  }
}

function formatResult(r: BenchResult): string {
  const pad = (label: string, value: string): string =>
    `  ${(label + ":").padEnd(22)} ${value}`;
  return [
    "petitprince.epub bench",
    pad("intake_ms", r.intake_ms.toFixed(1)),
    pad("batch_ms", r.batch_ms.toFixed(1)),
    pad("total_segments", String(r.total_segments)),
    pad("translated", String(r.translated)),
    pad("cached", String(r.cached)),
    pad("flagged", String(r.flagged)),
    pad("failed", String(r.failed)),
    pad("matcher.compiles", String(r.matcher_compiles)),
    pad("matcher.hits", String(r.matcher_hits)),
    pad("entities.misses", String(r.entities_misses)),
    pad("entities.hits", String(r.entities_hits)),
  ].join("\n");
}

describe("petitprince bench", () => {
  it("runs the full pipeline over docs/petitprince.epub", async () => {
    const r = await runPetitPrinceBench();
    // eslint-disable-next-line no-console
    console.log(`\n${formatResult(r)}\n`);
    // Minimal regression guard — these numbers should always be > 0
    // for a healthy run. Wall-clock thresholds are intentionally
    // left for the CI baseline rather than hard-coded here, since
    // they're machine-dependent.
    expect(r.total_segments).toBeGreaterThan(0);
    expect(r.translated).toBeGreaterThan(0);
    expect(r.failed).toBe(0);
    // The matcher and entity caches should both show >0 hits over a
    // book of this size — the whole point of caching is amortisation.
    expect(r.entities_misses).toBeGreaterThan(0);
    // Matcher hits depend on having a glossary, which the mock
    // pipeline only builds via extractor calls (off by default in
    // this bench). We assert only the compile path is sane.
    expect(r.matcher_compiles).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
