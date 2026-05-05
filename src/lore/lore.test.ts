/**
 * Lore Book lifecycle + attach + glossary unit tests.
 *
 * These tests run against `fake-indexeddb` (the same backend the rest
 * of the suite uses) so they exercise the real Dexie schema, not a
 * mock.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { libraryDb, resetLibraryDbCache } from "@/db/library";
import { openLoreDb } from "@/db/dexie";
import { AttachedLoreMode, GlossaryStatus, LoreSourceKind } from "@/db/schema";
import { createProject, deleteProject } from "@/db/repo/projects";
import {
  attachLoreBook,
  detachLoreBook,
  listAttachedLore,
  resolveProjectGlossaryWithLore,
  setAttachedLoreMode,
} from "@/lore/attach";
import {
  createLoreEntry,
  deleteLoreEntry,
  listLoreEntries,
  updateLoreEntry,
} from "@/lore/glossary";
import {
  createLoreBook,
  deleteLoreBook,
  listLoreSources,
  recordLoreSource,
  updateLoreMeta,
} from "@/lore/lore";
import {
  exportLoreBundle,
  importLoreBundle,
  parseLoreBundle,
  serializeLoreBundle,
} from "@/lore/io";
import { createGlossaryEntry } from "@/db/repo/glossary";

let lore_ids: string[] = [];
let project_ids: string[] = [];

beforeEach(() => {
  lore_ids = [];
  project_ids = [];
});

afterEach(async () => {
  for (const id of lore_ids) {
    try {
      await deleteLoreBook(id);
    } catch {
      // ignore
    }
  }
  for (const id of project_ids) {
    try {
      await deleteProject(id);
    } catch {
      // ignore
    }
  }
  await libraryDb().delete();
  resetLibraryDbCache();
});

async function makeLore(): Promise<string> {
  const handle = await createLoreBook({
    name: "Witcher PT",
    source_lang: "en",
    target_lang: "pt",
    description: "Witcher saga PT canonical names",
    default_proposal_kind: LoreSourceKind.TARGET,
  });
  lore_ids.push(handle.id);
  return handle.id;
}

async function makeProject(): Promise<string> {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const p = await createProject({
    name: "Lore-attached project",
    source_lang: "en",
    target_lang: "pt",
    source_filename: "p.epub",
    source_bytes: bytes.buffer,
  });
  project_ids.push(p.id);
  return p.id;
}

describe("Lore Book lifecycle", () => {
  it("creates a lore book with a library row", async () => {
    const id = await makeLore();
    const lib = await libraryDb().loreBooks.get(id);
    expect(lib).toBeDefined();
    expect(lib!.name).toBe("Witcher PT");
    expect(lib!.entries_total).toBe(0);
    expect(lib!.default_proposal_kind).toBe(LoreSourceKind.TARGET);
  });

  it("updateLoreMeta mirrors to the library row", async () => {
    const id = await makeLore();
    await updateLoreMeta(id, { name: "Witcher PT (revised)", description: "v2" });
    const lib = await libraryDb().loreBooks.get(id);
    expect(lib!.name).toBe("Witcher PT (revised)");
    expect(lib!.description).toBe("v2");
  });

  it("recordLoreSource + listLoreSources", async () => {
    const id = await makeLore();
    await recordLoreSource({
      lore_id: id,
      kind: LoreSourceKind.TARGET,
      epub_path: "first.epub",
      entries_added: 5,
    });
    const rows = await listLoreSources(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entries_added).toBe(5);
  });

  it("deleteLoreBook removes the DB and library row", async () => {
    const id = await makeLore();
    lore_ids = lore_ids.filter((x) => x !== id);
    await deleteLoreBook(id);
    const lib = await libraryDb().loreBooks.get(id);
    expect(lib).toBeUndefined();
  });
});

describe("Lore Book glossary", () => {
  it("creates and lists target-only entries", async () => {
    const id = await makeLore();
    await createLoreEntry(id, {
      source_term: null,
      target_term: "Geralt de Rívia",
      type: "character",
      status: GlossaryStatus.LOCKED,
      source_known: false,
    });
    const entries = await listLoreEntries(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry.target_term).toBe("Geralt de Rívia");
    expect(entries[0]!.entry.source_known).toBe(false);
  });

  it("rejects source_known=true without a source_term", async () => {
    const id = await makeLore();
    await expect(
      createLoreEntry(id, {
        source_term: null,
        target_term: "X",
        source_known: true,
      }),
    ).rejects.toThrow();
  });

  it("updateLoreEntry records a revision when target term changes", async () => {
    const id = await makeLore();
    const ent = await createLoreEntry(id, {
      source_term: "Geralt",
      target_term: "Geraldo",
      type: "character",
    });
    await updateLoreEntry(id, ent.entry.id, {
      target_term: "Geralt de Rívia",
      reason: "fixed",
    });
    const db = openLoreDb(id);
    const revs = await db.glossary_revisions.where("entry_id").equals(ent.entry.id).toArray();
    expect(revs).toHaveLength(1);
    expect(revs[0]!.new_target_term).toBe("Geralt de Rívia");
  });

  it("library counts refresh on entry create/delete", async () => {
    const id = await makeLore();
    const lib0 = await libraryDb().loreBooks.get(id);
    expect(lib0!.entries_total).toBe(0);
    const e1 = await createLoreEntry(id, {
      source_term: "X",
      target_term: "Y",
      status: GlossaryStatus.LOCKED,
    });
    const lib1 = await libraryDb().loreBooks.get(id);
    expect(lib1!.entries_total).toBe(1);
    expect(lib1!.entries_locked).toBe(1);
    await deleteLoreEntry(id, e1.entry.id);
    const lib2 = await libraryDb().loreBooks.get(id);
    expect(lib2!.entries_total).toBe(0);
    expect(lib2!.entries_locked).toBe(0);
  });
});

describe("Lore Book attach + projection", () => {
  it("attachLoreBook is idempotent and listed by priority", async () => {
    const lore_a = await makeLore();
    const lore_b = await makeLore();
    const project = await makeProject();

    const a = await attachLoreBook({
      project_id: project,
      lore_id: lore_a,
    });
    const b = await attachLoreBook({
      project_id: project,
      lore_id: lore_b,
    });
    // Same row update is idempotent on (project_id, lore_id).
    await attachLoreBook({
      project_id: project,
      lore_id: lore_a,
      mode: AttachedLoreMode.WRITABLE,
    });

    const rows = await listAttachedLore(project);
    expect(rows).toHaveLength(2);
    // Highest priority first.
    expect(rows[0]!.priority).toBeGreaterThanOrEqual(rows[1]!.priority);
    const a_row = rows.find((r) => r.lore_path === lore_a);
    expect(a_row!.mode).toBe(AttachedLoreMode.WRITABLE);
    expect(b.priority).toBeGreaterThan(a.priority);
  });

  it("detachLoreBook drops the row", async () => {
    const lore = await makeLore();
    const project = await makeProject();
    await attachLoreBook({ project_id: project, lore_id: lore });
    await detachLoreBook(project, lore);
    const rows = await listAttachedLore(project);
    expect(rows).toHaveLength(0);
  });

  it("setAttachedLoreMode changes the mode in place", async () => {
    const lore = await makeLore();
    const project = await makeProject();
    await attachLoreBook({ project_id: project, lore_id: lore });
    await setAttachedLoreMode(project, lore, AttachedLoreMode.WRITABLE);
    const rows = await listAttachedLore(project);
    expect(rows[0]!.mode).toBe(AttachedLoreMode.WRITABLE);
  });

  it("resolveProjectGlossaryWithLore merges with project-priority semantics", async () => {
    const lore_high = await makeLore();
    const lore_low = await makeLore();
    const project = await makeProject();

    // Lore (low priority): proposes Geralt -> Geraldo
    await createLoreEntry(lore_low, {
      source_term: "Geralt",
      target_term: "Geraldo",
      type: "character",
      status: GlossaryStatus.LOCKED,
    });
    // Lore (high priority): different translation, also locked.
    await createLoreEntry(lore_high, {
      source_term: "Geralt",
      target_term: "Geralt de Rívia",
      type: "character",
      status: GlossaryStatus.LOCKED,
    });
    // Lore (high priority): unique target-only entry
    await createLoreEntry(lore_high, {
      source_term: null,
      target_term: "Yennefer",
      type: "character",
      status: GlossaryStatus.LOCKED,
      source_known: false,
    });
    // Project glossary: an own confirmed translation that should win
    // over both Lore Books.
    await createGlossaryEntry(project, {
      project_id: project,
      source_term: "Ciri",
      target_term: "Cirilla",
      type: "character",
      status: GlossaryStatus.CONFIRMED,
    });
    // Project also contains a colliding entry that should win over both.
    await createGlossaryEntry(project, {
      project_id: project,
      source_term: "Geralt",
      target_term: "Geralt (project)",
      type: "character",
      status: GlossaryStatus.CONFIRMED,
    });

    // Attach: high priority first, then low.
    await attachLoreBook({
      project_id: project,
      lore_id: lore_high,
      priority: 10,
    });
    await attachLoreBook({
      project_id: project,
      lore_id: lore_low,
      priority: 1,
    });

    const own = await import("@/db/repo/glossary").then((m) =>
      m.listGlossaryEntries(project),
    );
    const merged = await resolveProjectGlossaryWithLore(project, own);

    const targets_for_geralt = merged
      .filter((e) => e.entry.source_term === "Geralt")
      .map((e) => e.entry.target_term);
    expect(targets_for_geralt).toHaveLength(1);
    expect(targets_for_geralt[0]).toBe("Geralt (project)");

    const yennefer_entries = merged.filter(
      (e) => e.entry.target_term === "Yennefer",
    );
    expect(yennefer_entries).toHaveLength(1);
    expect(yennefer_entries[0]!.entry.source_known).toBe(false);

    const ciri_entries = merged.filter(
      (e) => e.entry.source_term === "Ciri",
    );
    expect(ciri_entries).toHaveLength(1);
  });

  it("resolveProjectGlossaryWithLore filters Lore Books by cosine top-K when retrieval is set", async () => {
    const lore = await makeLore();
    const project = await makeProject();

    // Three Lore-Book entries — only one should win retrieval.
    const wanted = await createLoreEntry(lore, {
      source_term: "Geralt",
      target_term: "Geralt de Rívia",
      type: "character",
      status: GlossaryStatus.LOCKED,
    });
    const decoy_a = await createLoreEntry(lore, {
      source_term: "Triss",
      target_term: "Triss Merigold",
      type: "character",
      status: GlossaryStatus.LOCKED,
    });
    const decoy_b = await createLoreEntry(lore, {
      source_term: "Ciri",
      target_term: "Cirilla",
      type: "character",
      status: GlossaryStatus.LOCKED,
    });

    // Inject deterministic 4-dim vectors via the embeddings repo
    // directly so we don't depend on a provider in this test.
    const { bulkUpsertEmbeddings } = await import("@/db/repo/embeddings");
    const segment_vec = new Float32Array([1, 0, 0, 0]);
    await bulkUpsertEmbeddings("lore", lore, [
      {
        scope: "glossary_entry",
        ref_id: wanted.entry.id,
        model: "test-emb",
        vector: new Float32Array([1, 0, 0, 0]),
      },
      {
        scope: "glossary_entry",
        ref_id: decoy_a.entry.id,
        model: "test-emb",
        vector: new Float32Array([0, 1, 0, 0]),
      },
      {
        scope: "glossary_entry",
        ref_id: decoy_b.entry.id,
        model: "test-emb",
        vector: new Float32Array([0, 0, 1, 0]),
      },
    ]);

    await attachLoreBook({
      project_id: project,
      lore_id: lore,
      retrieval_top_k: 1,
      retrieval_min_similarity: 0.5,
    });

    const own = await import("@/db/repo/glossary").then((m) =>
      m.listGlossaryEntries(project),
    );
    const merged = await resolveProjectGlossaryWithLore(project, own, {
      segment_vec,
      embedding_model: "test-emb",
    });

    const merged_terms = merged.map((e) => e.entry.source_term).sort();
    expect(merged_terms).toEqual(["Geralt"]);
  });

  it("resolveProjectGlossaryWithLore skips an attached Lore Book that has no embeddings yet", async () => {
    const lore = await makeLore();
    const project = await makeProject();

    await createLoreEntry(lore, {
      source_term: "Geralt",
      target_term: "Geralt de Rívia",
      type: "character",
      status: GlossaryStatus.LOCKED,
    });

    await attachLoreBook({
      project_id: project,
      lore_id: lore,
      retrieval_top_k: 8,
    });

    const own = await import("@/db/repo/glossary").then((m) =>
      m.listGlossaryEntries(project),
    );
    const merged = await resolveProjectGlossaryWithLore(project, own, {
      segment_vec: new Float32Array([1, 0, 0, 0]),
      embedding_model: "test-emb",
    });

    expect(merged.filter((e) => e.entry.source_term === "Geralt")).toHaveLength(0);
  });

  it("resolveProjectGlossaryWithLore falls back to flat merge when retrieval_top_k <= 0", async () => {
    const lore = await makeLore();
    const project = await makeProject();

    await createLoreEntry(lore, {
      source_term: "Geralt",
      target_term: "Geralt de Rívia",
      type: "character",
      status: GlossaryStatus.LOCKED,
    });

    await attachLoreBook({
      project_id: project,
      lore_id: lore,
      retrieval_top_k: 0,
    });

    const own = await import("@/db/repo/glossary").then((m) =>
      m.listGlossaryEntries(project),
    );
    const merged = await resolveProjectGlossaryWithLore(project, own, {
      segment_vec: new Float32Array([1, 0, 0, 0]),
      embedding_model: "test-emb",
    });

    expect(merged.filter((e) => e.entry.source_term === "Geralt")).toHaveLength(1);
  });
});

describe("Lore Book bundle round-trip", () => {
  it("exports and re-imports a Lore Book", async () => {
    const id = await makeLore();
    await createLoreEntry(id, {
      source_term: "Geralt",
      target_term: "Geralt de Rívia",
      type: "character",
      status: GlossaryStatus.LOCKED,
      source_aliases: ["The Witcher"],
      target_aliases: ["o Lobo Branco"],
    });
    await createLoreEntry(id, {
      source_term: null,
      target_term: "Yennefer",
      type: "character",
      source_known: false,
      status: GlossaryStatus.PROPOSED,
    });

    const bundle = await exportLoreBundle(id);
    const json = serializeLoreBundle(bundle);
    const parsed = parseLoreBundle(json);
    expect(parsed.entries).toHaveLength(2);

    const result = await importLoreBundle(parsed, {
      name_override: "Witcher PT (copy)",
    });
    lore_ids.push(result.lore_id);
    const new_entries = await listLoreEntries(result.lore_id);
    expect(new_entries).toHaveLength(2);
    expect(new_entries.map((e) => e.entry.target_term).sort()).toEqual([
      "Geralt de Rívia",
      "Yennefer",
    ]);
    const lib = await libraryDb().loreBooks.get(result.lore_id);
    expect(lib!.name).toBe("Witcher PT (copy)");
  });
});
