/**
 * Unit tests for the translator-trace auto-proposer.
 *
 * The pipeline test only covers the mock provider's `new_entities: []`
 * happy-path; this file pokes at the proposer directly with a
 * hand-rolled trace so we know the canonical-form dedupe + year
 * filter behave the way the curator expects.
 */

import { describe, expect, it, afterEach } from "vitest";

import { autoProposeFromTranslatorTrace } from "./auto_propose";
import { createProject, deleteProject } from "@/db/repo/projects";
import { listGlossaryEntries } from "@/db/repo/glossary";
import { GlossaryStatus } from "@/db/schema";
import type { TranslatorTrace } from "@/llm/prompts/translator";

const SOURCE_BYTES = new ArrayBuffer(8);

const baseTrace = (
  entities: Array<Record<string, unknown>>,
): TranslatorTrace => ({
  target: "stub",
  used_entries: [],
  new_entities: entities,
  notes: null,
});

describe("autoProposeFromTranslatorTrace", () => {
  let projectId: string | null = null;

  afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = null;
  });

  async function setup(): Promise<string> {
    const project = await createProject({
      name: "Auto-propose",
      source_lang: "en",
      target_lang: "pt",
      source_filename: "x.epub",
      source_bytes: SOURCE_BYTES,
    });
    projectId = project.id;
    return project.id;
  }

  it("creates a proposed entry for a brand-new source term", async () => {
    const id = await setup();
    const outcome = await autoProposeFromTranslatorTrace({
      project_id: id,
      segment_id: "seg-1",
      trace: baseTrace([
        {
          type: "character",
          source: "Eira Stoneblood",
          target: "Eira Sangue de Pedra",
          evidence: "first chapter, ch.1",
        },
      ]),
      source_lang: "en",
      target_lang: "pt",
    });
    const entries = await listGlossaryEntries(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry.source_term).toBe("Eira Stoneblood");
    expect(entries[0]!.entry.target_term).toBe("Eira Sangue de Pedra");
    expect(entries[0]!.entry.status).toBe(GlossaryStatus.PROPOSED);
    expect(entries[0]!.entry.type).toBe("character");
    expect(entries[0]!.entry.first_seen_segment_id).toBe("seg-1");
    expect(outcome.created_entry_ids).toEqual([entries[0]!.entry.id]);
    expect(outcome.matched_entry_ids).toEqual([]);
  });

  it("reports matched-vs-created on a second sighting of the same term", async () => {
    const id = await setup();
    const first = await autoProposeFromTranslatorTrace({
      project_id: id,
      segment_id: "seg-1",
      trace: baseTrace([
        { type: "place", source: "The Iron Citadel", target: "A Cidadela de Ferro" },
      ]),
      source_lang: "en",
      target_lang: "pt",
    });
    const second = await autoProposeFromTranslatorTrace({
      project_id: id,
      segment_id: "seg-2",
      trace: baseTrace([
        { type: "place", source: "Iron Citadel", target: "Cidadela de Ferro" },
      ]),
      source_lang: "en",
      target_lang: "pt",
    });
    expect(first.created_entry_ids).toHaveLength(1);
    expect(second.created_entry_ids).toEqual([]);
    expect(second.matched_entry_ids).toEqual(first.created_entry_ids);
  });

  it("dedupes by canonical form (case + leading article)", async () => {
    const id = await setup();
    await autoProposeFromTranslatorTrace({
      project_id: id,
      segment_id: "seg-1",
      trace: baseTrace([
        { type: "place", source: "The Iron Citadel", target: "A Cidadela de Ferro" },
      ]),
      source_lang: "en",
      target_lang: "pt",
    });
    await autoProposeFromTranslatorTrace({
      project_id: id,
      segment_id: "seg-2",
      trace: baseTrace([
        { type: "place", source: "Iron Citadel", target: "Cidadela de Ferro" },
      ]),
      source_lang: "en",
      target_lang: "pt",
    });
    const entries = await listGlossaryEntries(id);
    expect(entries).toHaveLength(1);
  });

  it("skips raw year markers", async () => {
    const id = await setup();
    await autoProposeFromTranslatorTrace({
      project_id: id,
      segment_id: "seg-1",
      trace: baseTrace([
        { type: "date_or_time", source: "1066" },
        { type: "date_or_time", source: "1939-1945" },
        { type: "date_or_time", source: "1990s" },
        { type: "date_or_time", source: "c. 1066" },
        { type: "date_or_time", source: "Yule" },
      ]),
    });
    const entries = await listGlossaryEntries(id);
    expect(entries.map((e) => e.entry.source_term)).toEqual(["Yule"]);
  });

  it("ignores malformed candidates without crashing the pipeline", async () => {
    const id = await setup();
    await autoProposeFromTranslatorTrace({
      project_id: id,
      segment_id: "seg-1",
      trace: baseTrace([
        // Missing source — must be skipped silently.
        { type: "character" },
        // Empty source string — same.
        { type: "place", source: "   " },
        // Numeric source — skipped (not a string).
        { type: "term", source: 1234 as unknown as string },
        // Valid one in the same call still lands.
        { type: "term", source: "Aetheric Lattice" },
      ]),
    });
    const entries = await listGlossaryEntries(id);
    expect(entries.map((e) => e.entry.source_term)).toEqual([
      "Aetheric Lattice",
    ]);
  });
});
