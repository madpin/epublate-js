/**
 * Import a translation project's glossary into a Lore Book.
 *
 * Mirrors `epublate.lore.import_project`. Three policies:
 *
 *   - `"skip"`      — keep the destination entry, drop the incoming.
 *   - `"overwrite"` — update the destination entry's target term +
 *                     status + notes + gender + aliases.
 *   - `"collect"`   — return the conflicts in the summary so the UI
 *                     can walk them and call
 *                     {@link applyImportConflictResolution} per row.
 *
 * Matching follows the same rules as the Python version:
 *   - source-keyed entries dedup on `(source_term, type)`;
 *   - target-only entries are *always* inserted — different Lore
 *     Books may legitimately pin the same proper noun for unrelated
 *     entities, so silent merge would be wrong.
 */

import {
  listGlossaryEntries,
  type CreateGlossaryEntryInput,
} from "@/db/repo/glossary";
import { type GlossaryEntryRow } from "@/db/schema";

import {
  createLoreEntry,
  findLoreEntryBySourceTerm,
  setLoreEntryAliases,
  updateLoreEntry,
} from "./glossary";

export type ImportPolicy = "skip" | "overwrite" | "collect";

export interface ImportConflict {
  existing_id: string;
  source_term: string;
  type: GlossaryEntryRow["type"];
  existing: {
    target_term: string;
    status: GlossaryEntryRow["status"];
    gender: GlossaryEntryRow["gender"];
    notes: string | null;
    source_aliases: readonly string[];
    target_aliases: readonly string[];
  };
  incoming: {
    target_term: string;
    status: GlossaryEntryRow["status"];
    gender: GlossaryEntryRow["gender"];
    notes: string | null;
    source_aliases: readonly string[];
    target_aliases: readonly string[];
  };
}

export interface ImportSummary {
  created: number;
  updated: number;
  skipped: number;
  target_only_inserts: number;
  conflicts: ImportConflict[];
}

export type ConflictAction = "keep_existing" | "use_incoming" | "skip";

export async function importProjectGlossary(input: {
  source_project_id: string;
  dest_lore_id: string;
  policy?: ImportPolicy;
}): Promise<ImportSummary> {
  const policy = input.policy ?? "collect";
  const summary: ImportSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    target_only_inserts: 0,
    conflicts: [],
  };

  const src_entries = await listGlossaryEntries(input.source_project_id);
  for (const ent of src_entries) {
    const e = ent.entry;
    if (e.source_term == null || e.source_known === false) {
      // target-only entry — always insert
      const create_input: Parameters<typeof createLoreEntry>[1] = {
        source_term: null,
        target_term: e.target_term,
        type: e.type,
        status: e.status,
        gender: e.gender,
        notes: e.notes,
        source_known: false,
        source_aliases: ent.source_aliases,
        target_aliases: ent.target_aliases,
      };
      await createLoreEntry(input.dest_lore_id, create_input);
      summary.target_only_inserts += 1;
      summary.created += 1;
      continue;
    }

    const existing = await findLoreEntryBySourceTerm(
      input.dest_lore_id,
      e.source_term,
      e.type,
    );

    if (!existing) {
      const create_input: Parameters<typeof createLoreEntry>[1] = {
        source_term: e.source_term,
        target_term: e.target_term,
        type: e.type,
        status: e.status,
        gender: e.gender,
        notes: e.notes,
        source_known: true,
        source_aliases: ent.source_aliases,
        target_aliases: ent.target_aliases,
      };
      await createLoreEntry(input.dest_lore_id, create_input);
      summary.created += 1;
      continue;
    }

    if (policy === "skip") {
      summary.skipped += 1;
      continue;
    }

    if (policy === "overwrite") {
      await applyImportConflictResolution(
        input.dest_lore_id,
        existing.id,
        ent,
        "use_incoming",
      );
      summary.updated += 1;
      continue;
    }

    // policy === "collect"
    const existing_full = await listGlossaryEntries(input.dest_lore_id);
    const existing_with_aliases = existing_full.find(
      (x) => x.entry.id === existing.id,
    );
    summary.conflicts.push({
      existing_id: existing.id,
      source_term: e.source_term,
      type: e.type,
      existing: {
        target_term: existing.target_term,
        status: existing.status,
        gender: existing.gender,
        notes: existing.notes,
        source_aliases: existing_with_aliases?.source_aliases ?? [],
        target_aliases: existing_with_aliases?.target_aliases ?? [],
      },
      incoming: {
        target_term: e.target_term,
        status: e.status,
        gender: e.gender,
        notes: e.notes,
        source_aliases: ent.source_aliases,
        target_aliases: ent.target_aliases,
      },
    });
  }

  return summary;
}

export async function applyImportConflictResolution(
  dest_lore_id: string,
  existing_entry_id: string,
  incoming: { entry: GlossaryEntryRow; source_aliases: readonly string[]; target_aliases: readonly string[] } | {
    target_term: string;
    type?: GlossaryEntryRow["type"];
    status?: GlossaryEntryRow["status"];
    gender?: GlossaryEntryRow["gender"];
    notes?: string | null;
    source_aliases?: readonly string[];
    target_aliases?: readonly string[];
  },
  action: ConflictAction,
): Promise<void> {
  if (action === "keep_existing" || action === "skip") return;

  // Normalize the incoming shape — accept either a project entry or a
  // bare patch (used by the conflict-resolver UI).
  let patch_target_term: string;
  let patch_status: GlossaryEntryRow["status"] | undefined;
  let patch_gender: GlossaryEntryRow["gender"] | undefined;
  let patch_notes: string | null | undefined;
  let patch_type: GlossaryEntryRow["type"] | undefined;
  let src_aliases: readonly string[] | undefined;
  let tgt_aliases: readonly string[] | undefined;

  if ("entry" in incoming) {
    patch_target_term = incoming.entry.target_term;
    patch_status = incoming.entry.status;
    patch_gender = incoming.entry.gender;
    patch_notes = incoming.entry.notes;
    patch_type = incoming.entry.type;
    src_aliases = incoming.source_aliases;
    tgt_aliases = incoming.target_aliases;
  } else {
    patch_target_term = incoming.target_term;
    patch_status = incoming.status;
    patch_gender = incoming.gender;
    patch_notes = incoming.notes;
    patch_type = incoming.type;
    src_aliases = incoming.source_aliases;
    tgt_aliases = incoming.target_aliases;
  }

  await updateLoreEntry(dest_lore_id, existing_entry_id, {
    target_term: patch_target_term,
    status: patch_status,
    gender: patch_gender,
    notes: patch_notes,
    type: patch_type,
    reason: "imported from project",
  });
  if (src_aliases !== undefined || tgt_aliases !== undefined) {
    await setLoreEntryAliases(dest_lore_id, existing_entry_id, {
      source_aliases: src_aliases,
      target_aliases: tgt_aliases,
    });
  }
}

// Re-export so consumers can import from one place.
export type { CreateGlossaryEntryInput };
