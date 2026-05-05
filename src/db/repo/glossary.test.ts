import { afterEach, describe, expect, it } from "vitest";

import { createProject, deleteProject } from "@/db/repo/projects";
import {
  countMentionsPerEntry,
  createGlossaryEntry,
  deleteGlossaryEntry,
  findGlossaryEntryBySourceTerm,
  listAliases,
  listGlossaryEntries,
  listGlossaryRevisions,
  mergeGlossaryEntries,
  recordMentions,
  setAliases,
  updateGlossaryEntry,
} from "./glossary";

describe("glossary repo", () => {
  let projectId: string | null = null;

  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  async function makeProject(): Promise<string> {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const p = await createProject({
      name: "Glossary Test",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "g.epub",
      source_bytes: bytes.buffer,
    });
    projectId = p.id;
    return p.id;
  }

  it("creates and reloads an entry with aliases", async () => {
    const pid = await makeProject();
    const ent = await createGlossaryEntry(pid, {
      project_id: pid,
      source_term: "House of Commons",
      target_term: "Câmara dos Comuns",
      type: "place",
      status: "confirmed",
      source_aliases: ["the Commons"],
      target_aliases: ["a Câmara"],
    });
    expect(ent.entry.source_term).toBe("House of Commons");
    expect(ent.source_aliases).toEqual(["the Commons"]);

    const list = await listGlossaryEntries(pid);
    expect(list).toHaveLength(1);
    expect(list[0]!.entry.id).toBe(ent.entry.id);

    const aliases = await listAliases(pid, ent.entry.id);
    expect(aliases.map((a) => `${a.side}:${a.text}`).sort()).toEqual([
      "source:the Commons",
      "target:a Câmara",
    ]);
  });

  it("updates target_term and records a revision", async () => {
    const pid = await makeProject();
    const ent = await createGlossaryEntry(pid, {
      project_id: pid,
      source_term: "House",
      target_term: "Casa",
      status: "confirmed",
    });
    await updateGlossaryEntry(pid, ent.entry.id, {
      target_term: "Câmara",
      reason: "test",
    });
    const revisions = await listGlossaryRevisions(pid, ent.entry.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.prev_target_term).toBe("Casa");
    expect(revisions[0]!.new_target_term).toBe("Câmara");
  });

  it("findGlossaryEntryBySourceTerm picks one row", async () => {
    const pid = await makeProject();
    await createGlossaryEntry(pid, {
      project_id: pid,
      source_term: "Foo",
      target_term: "Bar",
      type: "term",
    });
    const found = await findGlossaryEntryBySourceTerm(pid, "Foo");
    expect(found).toBeDefined();
    expect(found?.target_term).toBe("Bar");
  });

  it("setAliases replaces existing aliases atomically", async () => {
    const pid = await makeProject();
    const ent = await createGlossaryEntry(pid, {
      project_id: pid,
      source_term: "Foo",
      target_term: "Bar",
      source_aliases: ["alpha", "beta"],
    });
    await setAliases(pid, ent.entry.id, {
      source_aliases: ["gamma"],
      target_aliases: ["delta"],
    });
    const aliases = await listAliases(pid, ent.entry.id);
    expect(aliases).toHaveLength(2);
    expect(aliases.find((a) => a.side === "source")?.text).toBe("gamma");
    expect(aliases.find((a) => a.side === "target")?.text).toBe("delta");
  });

  it("deleteGlossaryEntry sweeps aliases + revisions + mentions", async () => {
    const pid = await makeProject();
    const ent = await createGlossaryEntry(pid, {
      project_id: pid,
      source_term: "Foo",
      target_term: "Bar",
      source_aliases: ["alpha"],
    });
    await updateGlossaryEntry(pid, ent.entry.id, { target_term: "Baz" });
    await recordMentions(pid, "seg-1", [
      { entry_id: ent.entry.id, term: "Foo", start: 0, end: 3 },
    ]);
    await deleteGlossaryEntry(pid, ent.entry.id);
    const list = await listGlossaryEntries(pid);
    expect(list).toHaveLength(0);
    const aliases = await listAliases(pid, ent.entry.id);
    expect(aliases).toHaveLength(0);
    const revisions = await listGlossaryRevisions(pid, ent.entry.id);
    expect(revisions).toHaveLength(0);
  });

  it("recordMentions + countMentionsPerEntry agree", async () => {
    const pid = await makeProject();
    const ent = await createGlossaryEntry(pid, {
      project_id: pid,
      source_term: "Foo",
      target_term: "Bar",
    });
    await recordMentions(pid, "seg-1", [
      { entry_id: ent.entry.id, term: "Foo", start: 0, end: 3 },
      { entry_id: ent.entry.id, term: "Foo", start: 10, end: 13 },
    ]);
    await recordMentions(pid, "seg-2", [
      { entry_id: ent.entry.id, term: "Foo", start: 0, end: 3 },
    ]);
    const counts = await countMentionsPerEntry(pid);
    expect(counts[ent.entry.id]?.mentions).toBe(3);
    expect(counts[ent.entry.id]?.segments).toBe(2);
  });

  it("mergeGlossaryEntries folds losers into winner with revision", async () => {
    const pid = await makeProject();
    const winner = await createGlossaryEntry(pid, {
      project_id: pid,
      source_term: "House",
      target_term: "Câmara",
      status: "confirmed",
      source_aliases: ["Commons"],
    });
    const loser = await createGlossaryEntry(pid, {
      project_id: pid,
      source_term: "House",
      target_term: "Casa",
      status: "proposed",
      source_aliases: ["the House"],
    });
    const folded = await mergeGlossaryEntries(pid, {
      winner_id: winner.entry.id,
      loser_ids: [loser.entry.id],
    });
    expect(folded).toBe(1);
    const list = await listGlossaryEntries(pid);
    expect(list).toHaveLength(1);
    const aliases = await listAliases(pid, winner.entry.id);
    const sources = aliases.filter((a) => a.side === "source").map((a) => a.text);
    const targets = aliases.filter((a) => a.side === "target").map((a) => a.text);
    expect(new Set(sources)).toEqual(new Set(["Commons", "the House"]));
    expect(new Set(targets)).toEqual(new Set(["Casa"]));
  });
});
