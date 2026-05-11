import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProject, deleteProject } from "@/db/repo/projects";
import { listChapters } from "@/db/repo/chapters";
import { openProjectDb } from "@/db/dexie";
import { runProjectIntake } from "@/core/project_intake";
import {
  runBatch,
  BatchPaused,
  deriveConcurrencyCap,
  resolveBatchRetryConfig,
  BATCH_RETRY_DEFAULTS,
} from "@/core/batch";
import { MockProvider } from "@/llm/mock";
import {
  type ChatRequest,
  type ChatResult,
  type LLMProvider,
  type RateLimitHint,
} from "@/llm/base";

const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:test:book</dc:identifier>
    <dc:title>Batch Test</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>One</title></head>
  <body>
    <p>The first paragraph.</p>
    <p>And a second paragraph.</p>
  </body>
</html>`;

const CH2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Two</title></head>
  <body>
    <p>Chapter two opens.</p>
  </body>
</html>`;

async function makeTestEpub(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file("OEBPS/content.opf", OPF);
  zip.file("OEBPS/ch1.xhtml", CH1);
  zip.file("OEBPS/ch2.xhtml", CH2);
  const u8 = await zip.generateAsync({ type: "uint8array" });
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

describe("resolveBatchRetryConfig", () => {
  it("falls back to BATCH_RETRY_DEFAULTS when nothing is set", () => {
    expect(resolveBatchRetryConfig(null)).toEqual(BATCH_RETRY_DEFAULTS);
    expect(resolveBatchRetryConfig(undefined)).toEqual(BATCH_RETRY_DEFAULTS);
    expect(resolveBatchRetryConfig({})).toEqual(BATCH_RETRY_DEFAULTS);
  });

  it("clamps malformed numeric fields to defaults", () => {
    const r = resolveBatchRetryConfig({
      max_retries_per_segment: -1,
      error_window_size: 0,
      max_errors_in_window: NaN,
    });
    expect(r).toEqual(BATCH_RETRY_DEFAULTS);
  });

  it("forces window size to be at least the threshold", () => {
    const r = resolveBatchRetryConfig({
      error_window_size: 5,
      max_errors_in_window: 50,
    });
    expect(r.error_window_size).toBe(50);
    expect(r.max_errors_in_window).toBe(50);
  });

  it("preserves legitimate overrides", () => {
    const r = resolveBatchRetryConfig({
      max_retries_per_segment: 5,
      error_window_size: 200,
      max_errors_in_window: 25,
    });
    expect(r).toEqual({
      max_retries_per_segment: 5,
      error_window_size: 200,
      max_errors_in_window: 25,
    });
  });

  it("truncates fractional integer fields", () => {
    const r = resolveBatchRetryConfig({
      max_retries_per_segment: 3.7,
      error_window_size: 100.4,
      max_errors_in_window: 10.9,
    });
    expect(r.max_retries_per_segment).toBe(3);
    expect(r.error_window_size).toBe(100);
    expect(r.max_errors_in_window).toBe(10);
  });
});

describe("runBatch", () => {
  let projectId: string | null = null;

  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("translates every pending segment and records counts", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Batch",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "b.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "b.epub",
    });

    const provider = new MockProvider();
    const summary = await runBatch({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      provider,
      options: { model: "mock-model", concurrency: 2 },
    });

    expect(summary.total).toBeGreaterThanOrEqual(3);
    expect(summary.translated).toBeGreaterThanOrEqual(3);
    expect(summary.failed).toBe(0);
    expect(summary.elapsed_s).toBeGreaterThanOrEqual(0);

    // Re-run: every prior call is now cached, and the budget is fresh.
    const second = await runBatch({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      provider,
      options: { model: "mock-model" },
    });
    // Already-translated segments are no longer pending, so the second
    // run is a no-op.
    expect(second.total).toBe(0);
    expect(second.translated).toBe(0);
  });

  it("pauses on the budget cap and throws BatchPaused", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Budget",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "g.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "g.epub",
    });

    // Force every call to "cost" something via a priced model + non-zero token usage.
    const provider = new MockProvider();
    vi.spyOn(provider, "chat").mockImplementation(async () => ({
      content: '{"target":"[paid]","used_entries":[],"new_entities":[]}',
      usage: {
        prompt_tokens: 100_000,
        completion_tokens: 100_000,
        total_tokens: 200_000,
      },
      model: "gpt-4-turbo",
      cache_hit: false,
      raw: null,
    }));

    let threw: BatchPaused | null = null;
    try {
      await runBatch({
        project_id: project.id,
        source_lang: "en",
        target_lang: "pt",
        provider,
        // gpt-4-turbo: 100k input + 100k output = $1.00 + $3.00 = $4.00 per call
        options: { model: "gpt-4-turbo", budget_usd: 1, concurrency: 1 },
      });
    } catch (err: unknown) {
      if (err instanceof BatchPaused) threw = err;
      else throw err;
    }
    expect(threw).not.toBeNull();
    expect(threw!.summary.cost_usd).toBeGreaterThanOrEqual(1);
    expect(threw!.summary.paused_reason).toMatch(/budget cap/);
  });

  it("isolates per-segment failures and continues", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Failure",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "f.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "f.epub",
    });

    const provider = new MockProvider();
    let n = 0;
    vi.spyOn(provider, "chat").mockImplementation(async (input) => {
      n += 1;
      if (n === 2) throw new Error("boom on second call");
      const real = new MockProvider();
      return real.chat(input);
    });

    const summary = await runBatch({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      provider,
      // Disable the batch-level retry layer so the failure isolation
      // assertion is testing what it says — a single failing segment
      // doesn't sink the run. The retry layer has its own dedicated
      // tests below.
      options: {
        model: "mock-model",
        concurrency: 1,
        retry: { max_retries_per_segment: 0 },
      },
    });

    expect(summary.failed).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].error).toMatch(/boom/);
    expect(summary.translated).toBeGreaterThanOrEqual(2);

    // The runner should have written a `batch.segment_failed` event.
    const db = openProjectDb(project.id);
    const events = await db.events.toArray();
    const fail_evt = events.filter((e) => e.kind === "batch.segment_failed");
    expect(fail_evt.length).toBeGreaterThanOrEqual(1);
  });

  it("fires on_segment_start before each translateSegment and on_segment_end after", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Lifecycle",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "lc.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "lc.epub",
    });

    const provider = new MockProvider();
    const events: { kind: "start" | "end"; segment_id: string }[] = [];
    await runBatch({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      provider,
      options: { model: "mock-model", concurrency: 1 },
      on_segment_start: ({ segment_id }) =>
        events.push({ kind: "start", segment_id }),
      on_segment_end: ({ segment_id }) =>
        events.push({ kind: "end", segment_id }),
    });

    // Each segment must produce exactly one start + one end, in that order
    // (concurrency=1 keeps them strictly interleaved).
    expect(events.length).toBeGreaterThan(0);
    expect(events.length % 2).toBe(0);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i].kind).toBe("start");
      expect(events[i + 1].kind).toBe("end");
      expect(events[i].segment_id).toBe(events[i + 1].segment_id);
    }
  });

  it("retries a failing segment up to max_retries_per_segment then records a failure", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Retry",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "r.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "r.epub",
    });

    // Fail one specific segment on every retry so we exhaust the
    // retry budget and produce a single failure record. Other
    // segments succeed on the first try. We identify "the same
    // segment again" by content fingerprint — retries reuse the
    // exact same user prompt, which is a robust proxy for segment
    // identity without coupling the test to the prompt template.
    const provider = new MockProvider();
    let target_fingerprint: string | null = null;
    const target_calls: number[] = [];
    let call_count = 0;
    vi.spyOn(provider, "chat").mockImplementation(async (input) => {
      call_count += 1;
      const fp = JSON.stringify(input.messages);
      if (target_fingerprint === null) target_fingerprint = fp;
      if (fp === target_fingerprint) {
        target_calls.push(call_count);
        throw new Error(`network error talking to http://localhost: simulated`);
      }
      const real = new MockProvider();
      return real.chat(input);
    });

    const summary = await runBatch({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      provider,
      options: {
        model: "mock-model",
        concurrency: 1,
        retry: { max_retries_per_segment: 2 },
      },
    });

    // Exactly one segment failed (after 1 normal try + 2 retries = 3 attempts).
    expect(summary.failed).toBe(1);
    expect(target_calls.length).toBe(3);

    // The audit log should show one `batch.segment_retry` per attempt
    // plus one terminal `batch.segment_failed`.
    const db = openProjectDb(project.id);
    const events = await db.events.toArray();
    const retries = events.filter((e) => e.kind === "batch.segment_retry");
    const failed = events.filter((e) => e.kind === "batch.segment_failed");
    expect(retries.length).toBe(3);
    expect(failed.length).toBe(1);
  });

  it("succeeds when an early retry attempt fixes a transient failure", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Retry-Success",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "rs.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "rs.epub",
    });

    // First call fails, second succeeds. With max_retries=1 the
    // retry layer should rescue the segment.
    const provider = new MockProvider();
    let calls = 0;
    vi.spyOn(provider, "chat").mockImplementation(async (input) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient network blip");
      }
      const real = new MockProvider();
      return real.chat(input);
    });

    const summary = await runBatch({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      provider,
      options: {
        model: "mock-model",
        concurrency: 1,
        retry: { max_retries_per_segment: 1 },
      },
    });

    expect(summary.failed).toBe(0);
    expect(summary.translated).toBeGreaterThanOrEqual(1);
  });

  it("trips the circuit breaker when failures exceed the window threshold", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Breaker",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "b.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "b.epub",
    });

    // Fail every call to guarantee we hit the threshold quickly.
    const provider = new MockProvider();
    vi.spyOn(provider, "chat").mockImplementation(async () => {
      throw new Error("everything is broken");
    });

    let threw: BatchPaused | null = null;
    try {
      await runBatch({
        project_id: project.id,
        source_lang: "en",
        target_lang: "pt",
        provider,
        options: {
          model: "mock-model",
          concurrency: 1,
          retry: {
            max_retries_per_segment: 0,
            error_window_size: 2,
            max_errors_in_window: 2,
          },
        },
      });
    } catch (err: unknown) {
      if (err instanceof BatchPaused) threw = err;
      else throw err;
    }

    expect(threw).not.toBeNull();
    expect(threw!.summary.paused_reason).toMatch(/circuit breaker tripped/);
    // We tripped at the threshold (2 failures), so the run did not
    // attempt every segment in the project.
    expect(threw!.summary.failed).toBeGreaterThanOrEqual(2);

    const db = openProjectDb(project.id);
    const events = await db.events.toArray();
    const breaker_evt = events.filter(
      (e) => e.kind === "batch.circuit_breaker",
    );
    expect(breaker_evt.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by chapter_ids", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "Filter",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "x.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "x.epub",
    });

    const chapters = await listChapters(project.id);
    const ch1 = chapters[0];

    const provider = new MockProvider();
    const summary = await runBatch({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      provider,
      options: {
        model: "mock-model",
        chapter_ids: [ch1.id],
      },
    });

    // Only the segments inside the first chapter should be in scope.
    expect(summary.total).toBeGreaterThanOrEqual(2);
    const db = openProjectDb(project.id);
    const segs2 = await db.segments
      .where("chapter_id")
      .equals(chapters[1]!.id)
      .toArray();
    for (const s of segs2) {
      expect(s.target_text).toBeNull();
    }
  });
});

describe("deriveConcurrencyCap", () => {
  it("returns the configured cap when no hint is available", () => {
    expect(deriveConcurrencyCap(8, null)).toBe(8);
    expect(deriveConcurrencyCap(1, null)).toBe(1);
  });

  it("returns the configured cap when remaining_requests is unknown", () => {
    const hint: RateLimitHint = {
      remaining_requests: null,
      remaining_tokens: 10_000,
      reset_requests_ms: null,
      reset_tokens_ms: 60_000,
      observed_at: 0,
    };
    expect(deriveConcurrencyCap(6, hint)).toBe(6);
  });

  it("halves remaining_requests with safety factor; floors at 1", () => {
    const make = (rem: number): RateLimitHint => ({
      remaining_requests: rem,
      remaining_tokens: null,
      reset_requests_ms: null,
      reset_tokens_ms: null,
      observed_at: 0,
    });
    expect(deriveConcurrencyCap(10, make(20))).toBe(10);
    expect(deriveConcurrencyCap(10, make(8))).toBe(4);
    expect(deriveConcurrencyCap(10, make(3))).toBe(1);
    expect(deriveConcurrencyCap(10, make(1))).toBe(1);
    expect(deriveConcurrencyCap(10, make(0))).toBe(1);
  });

  it("never amplifies beyond the configured cap", () => {
    const hint: RateLimitHint = {
      remaining_requests: 10_000,
      remaining_tokens: null,
      reset_requests_ms: null,
      reset_tokens_ms: null,
      observed_at: 0,
    };
    expect(deriveConcurrencyCap(4, hint)).toBe(4);
  });
});

/**
 * Mock provider that tracks the maximum number of concurrent `chat`
 * calls and exposes a programmable rate-limit hint per call. We use
 * it to drive the adaptive-concurrency tests below.
 */
class TrackingRateLimitedProvider implements LLMProvider {
  readonly name = "mock_rate_limited";
  inFlight = 0;
  maxConcurrent = 0;
  totalCalls = 0;
  private hint: RateLimitHint | null = null;
  private readonly real = new MockProvider();
  /** Caller-supplied per-call hook to mutate the next hint. */
  hintFor: (callIdx: number) => RateLimitHint | null = () => null;

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.inFlight += 1;
    this.totalCalls += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    try {
      // Yield so concurrency actually observes overlap.
      await new Promise((r) => setTimeout(r, 5));
      const result = await this.real.chat(request);
      this.hint = this.hintFor(this.totalCalls);
      return result;
    } finally {
      this.inFlight -= 1;
    }
  }

  getRateLimitHint(): RateLimitHint | null {
    return this.hint;
  }
}

describe("runBatch adaptive concurrency", () => {
  let projectId: string | null = null;

  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("keeps configured concurrency when the provider exposes no hint", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "AdaptiveNoHint",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "anh.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "anh.epub",
    });

    const provider = new TrackingRateLimitedProvider();
    provider.hintFor = () => null;

    const summary = await runBatch({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      provider,
      options: { model: "mock-model", concurrency: 3 },
    });

    expect(summary.failed).toBe(0);
    expect(provider.maxConcurrent).toBeGreaterThanOrEqual(2);
    // No hint → no concurrency-adjusted events.
    const db = openProjectDb(project.id);
    const events = await db.events.toArray();
    expect(events.some((e) => e.kind === "batch.concurrency_adjusted")).toBe(
      false,
    );
  });

  it("attenuates concurrency when remaining_requests is low", async () => {
    const bytes = await makeTestEpub();
    const project = await createProject({
      name: "AdaptiveLow",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "al.epub",
      source_bytes: bytes,
    });
    projectId = project.id;
    await runProjectIntake({
      project_id: project.id,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      epub_bytes: bytes,
      source_filename: "al.epub",
    });

    const provider = new TrackingRateLimitedProvider();
    // Report `remaining_requests = 2` from the very first call —
    // derive: floor(2/2)=1 → throttle cap floors at 1.
    provider.hintFor = () => ({
      remaining_requests: 2,
      remaining_tokens: 100_000,
      reset_requests_ms: 60_000,
      reset_tokens_ms: 60_000,
      observed_at: 0,
    });

    const summary = await runBatch({
      project_id: project.id,
      source_lang: "en",
      target_lang: "pt",
      provider,
      options: { model: "mock-model", concurrency: 4 },
    });

    expect(summary.failed).toBe(0);
    // After the first call's response is sampled the cap drops to 1,
    // so peak concurrency from then on must be 1. The very first
    // wave (before any hint is observed) may briefly exceed the cap
    // because all workers start in parallel — assert the configured
    // cap is still respected.
    expect(provider.maxConcurrent).toBeLessThanOrEqual(4);
    // We should have written at least one adjustment event.
    const db = openProjectDb(project.id);
    const events = await db.events.toArray();
    const adjustments = events.filter(
      (e) => e.kind === "batch.concurrency_adjusted",
    );
    expect(adjustments.length).toBeGreaterThanOrEqual(1);
    const first = JSON.parse(adjustments[0]!.payload_json) as {
      from: number;
      to: number;
      configured: number;
      remaining_requests: number | null;
    };
    expect(first.configured).toBe(4);
    expect(first.from).toBe(4);
    expect(first.to).toBe(1);
    expect(first.remaining_requests).toBe(2);
  });

  // Recovery (1 → N) is exercised by the deterministic unit tests:
  //   - `Throttle.test.ts` ("setCap(higher) wakes parked waiters")
  //   - `deriveConcurrencyCap` ("never amplifies beyond cap; rises
  //     back when remaining_requests increases")
  // Pinning recovery in an end-to-end batch run would require a
  // single-call serialiser to defeat the multi-worker race, which
  // adds test infrastructure without exercising new production
  // code. Documented here so a future contributor doesn't re-add a
  // flaky version of the test.
});
