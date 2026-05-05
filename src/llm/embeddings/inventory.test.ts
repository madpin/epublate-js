/**
 * Tests for `inventory.ts`: model histograms, re-embed orchestration,
 * and stale-row purging.
 *
 * The fixture pipeline is the same as `embedding_pass.test.ts` — we
 * build a one-chapter ePub, run intake, then drive the embedding
 * helpers directly. Each test owns its `projectId` so the suite can
 * tear down the project DB on `afterEach` regardless of failures.
 */

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { runProjectIntake } from "@/core/project_intake";
import { createProject, deleteProject } from "@/db/repo/projects";
import { createGlossaryEntry } from "@/db/repo/glossary";
import {
  bulkUpsertEmbeddings,
  countEmbeddingsByScope,
  type UpsertEmbeddingInput,
} from "@/db/repo/embeddings";
import { GlossaryStatus } from "@/db/schema";
import { MockEmbeddingProvider } from "@/llm/embeddings/mock";
import {
  getProjectEmbeddingInventory,
  purgeStaleEmbeddings,
  reembedProject,
} from "@/llm/embeddings/inventory";

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
    <dc:title>Inventory Test</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`;

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>One</title></head>
  <body>
    <p>Lorem ipsum dolor sit amet.</p>
    <p>Consectetur adipiscing elit.</p>
    <p>Sed do eiusmod tempor incididunt.</p>
  </body>
</html>`;

async function makeTestEpub(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file("OEBPS/content.opf", OPF);
  zip.file("OEBPS/ch1.xhtml", CH1);
  const u8 = await zip.generateAsync({ type: "uint8array" });
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

async function bootstrap(name: string): Promise<string> {
  const bytes = await makeTestEpub();
  const filename = `${name.toLowerCase().replace(/\s/g, "-")}.epub`;
  const project = await createProject({
    name,
    source_lang: "en",
    target_lang: "pt",
    source_filename: filename,
    source_bytes: bytes,
  });
  await runProjectIntake({
    project_id: project.id,
    source_lang: project.source_lang,
    target_lang: project.target_lang,
    epub_bytes: bytes,
    source_filename: filename,
  });
  return project.id;
}

describe("getProjectEmbeddingInventory", () => {
  let projectId: string | null = null;

  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("reports `total - active = missing` when nothing is embedded yet", async () => {
    projectId = await bootstrap("Inv empty");
    const inv = await getProjectEmbeddingInventory(projectId, "model-a");
    expect(inv.active_model).toBe("model-a");
    expect(inv.segment.total).toBeGreaterThan(0);
    expect(inv.segment.active).toBe(0);
    expect(inv.segment.stale).toBe(0);
    expect(inv.segment.by_model).toEqual([]);
  });

  it("flags rows under a different model as stale", async () => {
    projectId = await bootstrap("Inv stale");
    const provider = new MockEmbeddingProvider({ model: "old-model", dim: 16 });
    await reembedProject(projectId, provider);

    const inv = await getProjectEmbeddingInventory(projectId, "new-model");
    expect(inv.active_model).toBe("new-model");
    // Every segment got a vector under `old-model`, none under `new-model`.
    expect(inv.segment.active).toBe(0);
    expect(inv.segment.stale).toBe(inv.segment.total);
    expect(inv.segment.by_model.find((m) => m.model === "old-model")?.count).toBe(
      inv.segment.total,
    );
  });

  it("counts rows under the active model as active, not stale", async () => {
    projectId = await bootstrap("Inv active");
    const provider = new MockEmbeddingProvider({ model: "m1", dim: 16 });
    await reembedProject(projectId, provider);

    const inv = await getProjectEmbeddingInventory(projectId, "m1");
    expect(inv.segment.active).toBe(inv.segment.total);
    expect(inv.segment.stale).toBe(0);
  });

  it("includes glossary stats", async () => {
    projectId = await bootstrap("Inv gloss");
    await createGlossaryEntry(projectId, {
      project_id: projectId,
      source_term: "amet",
      target_term: "amen",
      notes: null,
      status: GlossaryStatus.PROPOSED,
    });
    const provider = new MockEmbeddingProvider({ model: "m1", dim: 16 });
    await reembedProject(projectId, provider);

    const inv = await getProjectEmbeddingInventory(projectId, "m1");
    expect(inv.glossary_entry.total).toBe(1);
    expect(inv.glossary_entry.active).toBe(1);
  });
});

describe("reembedProject + purgeStaleEmbeddings", () => {
  let projectId: string | null = null;
  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("re-embeds segments under the new model without deleting old rows", async () => {
    projectId = await bootstrap("Reembed retain");
    const old_provider = new MockEmbeddingProvider({ model: "old", dim: 16 });
    await reembedProject(projectId, old_provider);

    const new_provider = new MockEmbeddingProvider({ model: "new", dim: 16 });
    const summary = await reembedProject(projectId, new_provider);

    expect(summary.segments?.embedded).toBeGreaterThan(0);
    expect(summary.purged).toBe(0);

    // Both models keep rows when `purge_stale` is off.
    const old_count = await countEmbeddingsByScope("project", projectId, "segment", "old");
    const new_count = await countEmbeddingsByScope("project", projectId, "segment", "new");
    expect(old_count).toBeGreaterThan(0);
    expect(new_count).toBeGreaterThan(0);
    expect(new_count).toBe(old_count);
  });

  it("purges rows under non-active models when purge_stale=true", async () => {
    projectId = await bootstrap("Reembed purge");
    const old_provider = new MockEmbeddingProvider({ model: "old", dim: 16 });
    await reembedProject(projectId, old_provider);

    const new_provider = new MockEmbeddingProvider({ model: "new", dim: 16 });
    const summary = await reembedProject(projectId, new_provider, {
      purge_stale: true,
    });

    expect(summary.purged).toBeGreaterThan(0);
    const old_count = await countEmbeddingsByScope("project", projectId, "segment", "old");
    const new_count = await countEmbeddingsByScope("project", projectId, "segment", "new");
    expect(old_count).toBe(0);
    expect(new_count).toBeGreaterThan(0);
  });
});

describe("purgeStaleEmbeddings (direct)", () => {
  let projectId: string | null = null;
  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  it("no-ops when nothing is stale", async () => {
    projectId = await bootstrap("Purge noop");
    const provider = new MockEmbeddingProvider({ model: "active", dim: 16 });
    await reembedProject(projectId, provider);
    const purged = await purgeStaleEmbeddings(projectId, "active");
    expect(purged).toBe(0);
  });

  it("removes only the rows whose model differs from keep_model", async () => {
    projectId = await bootstrap("Purge mixed");
    // Hand-write rows under three models to make the histogram explicit.
    const fixture: UpsertEmbeddingInput[] = [
      { scope: "segment", ref_id: "s1", model: "a", vector: new Float32Array([1, 0, 0]) },
      { scope: "segment", ref_id: "s1", model: "b", vector: new Float32Array([0, 1, 0]) },
      { scope: "segment", ref_id: "s2", model: "a", vector: new Float32Array([1, 1, 0]) },
      { scope: "segment", ref_id: "s2", model: "c", vector: new Float32Array([0, 0, 1]) },
    ];
    await bulkUpsertEmbeddings("project", projectId, fixture);

    const purged = await purgeStaleEmbeddings(projectId, "a");
    expect(purged).toBe(2);
    expect(await countEmbeddingsByScope("project", projectId, "segment", "a")).toBe(2);
    expect(await countEmbeddingsByScope("project", projectId, "segment", "b")).toBe(0);
    expect(await countEmbeddingsByScope("project", projectId, "segment", "c")).toBe(0);
  });
});
