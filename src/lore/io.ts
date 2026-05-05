/**
 * Lore Book bundle export / import.
 *
 * The on-disk shape is the `<name>.epublate-lore.json` format
 * documented in the plan: a single JSON object with `meta`,
 * `entries`, `aliases`, `revisions`, `sources`. Bundles are
 * versioned (`schema_version: 1`) and forward-compatible — older
 * bundles missing a field default to the safest reading.
 */

import { newId } from "@/lib/id";
import { nowMs } from "@/lib/time";

import { openLoreDb } from "@/db/dexie";
import {
  type GlossaryAliasRow,
  type GlossaryEntryRow,
  type GlossaryRevisionRow,
  type LoreMetaRow,
  type LoreSourceRow,
  type ProjectRow,
} from "@/db/schema";

import { createLoreBook } from "./lore";

export const LORE_BUNDLE_SCHEMA_VERSION = 1;

export interface LoreBundle {
  schema_version: number;
  exported_at: number;
  meta: {
    id: string;
    name: string;
    source_lang: string;
    target_lang: string;
    description: string | null;
    default_proposal_kind: LoreMetaRow["default_proposal_kind"];
    created_at: number;
  };
  entries: GlossaryEntryRow[];
  aliases: GlossaryAliasRow[];
  revisions: GlossaryRevisionRow[];
  sources: LoreSourceRow[];
}

export async function exportLoreBundle(lore_id: string): Promise<LoreBundle> {
  const db = openLoreDb(lore_id);
  const project = await db.projects.get(lore_id);
  if (!project) throw new Error(`lore book not found: ${lore_id}`);
  const meta = await db.lore_meta.get(lore_id);
  if (!meta) {
    throw new Error(`lore_meta missing for lore book ${lore_id}`);
  }

  const entries = await db.glossary_entries
    .where("project_id")
    .equals(lore_id)
    .toArray();
  const ids = entries.map((e) => e.id);
  const aliases = ids.length
    ? await db.glossary_aliases.where("entry_id").anyOf(ids).toArray()
    : [];
  const revisions = ids.length
    ? await db.glossary_revisions.where("entry_id").anyOf(ids).toArray()
    : [];
  const sources = await db.lore_sources
    .where("project_id")
    .equals(lore_id)
    .toArray();

  return {
    schema_version: LORE_BUNDLE_SCHEMA_VERSION,
    exported_at: nowMs(),
    meta: {
      id: project.id,
      name: project.name,
      source_lang: project.source_lang,
      target_lang: project.target_lang,
      description: meta.description,
      default_proposal_kind: meta.default_proposal_kind,
      created_at: project.created_at,
    },
    entries,
    aliases,
    revisions,
    sources,
  };
}

export interface ImportBundleOptions {
  /** When `true`, the new Lore Book reuses the bundle's id. */
  preserve_id?: boolean;
  /** Override the imported name. Trims to 80 chars. */
  name_override?: string;
}

/**
 * Import a Lore Book bundle into a brand-new Lore Book DB.
 *
 * We intentionally do *not* support merging into an existing Lore
 * Book here — the `import-from-existing-project` flow handles
 * conflict-driven imports against an open Lore Book. Bundles are
 * meant to be portable round-trips of one whole Lore Book.
 */
export async function importLoreBundle(
  bundle: LoreBundle,
  opts: ImportBundleOptions = {},
): Promise<{ lore_id: string; entries_count: number }> {
  if (
    !bundle ||
    typeof bundle !== "object" ||
    bundle.schema_version !== LORE_BUNDLE_SCHEMA_VERSION
  ) {
    throw new Error(
      `lore bundle schema_version ${bundle?.schema_version} not supported`,
    );
  }
  if (!bundle.meta || typeof bundle.meta.name !== "string") {
    throw new Error("lore bundle is missing required meta.name");
  }

  const handle = await createLoreBook({
    name: opts.name_override ?? bundle.meta.name,
    source_lang: bundle.meta.source_lang,
    target_lang: bundle.meta.target_lang,
    description: bundle.meta.description,
    default_proposal_kind: bundle.meta.default_proposal_kind,
  });
  const new_id = handle.id;
  const db = openLoreDb(new_id);

  /* --- remap entries to the new lore_id and reissue ids --- */
  const id_map = new Map<string, string>();
  const remapped_entries: GlossaryEntryRow[] = bundle.entries.map((e) => {
    const new_entry_id = opts.preserve_id ? e.id : newId();
    id_map.set(e.id, new_entry_id);
    return {
      ...e,
      id: new_entry_id,
      project_id: new_id,
    };
  });
  const remapped_aliases: GlossaryAliasRow[] = bundle.aliases.map((a) => ({
    ...a,
    id: opts.preserve_id ? a.id : newId(),
    entry_id: id_map.get(a.entry_id) ?? a.entry_id,
  }));
  const remapped_revisions: GlossaryRevisionRow[] = bundle.revisions.map(
    (r) => ({
      ...r,
      id: opts.preserve_id ? r.id : newId(),
      entry_id: id_map.get(r.entry_id) ?? r.entry_id,
    }),
  );
  const remapped_sources: LoreSourceRow[] = bundle.sources.map((s) => ({
    ...s,
    id: opts.preserve_id ? s.id : newId(),
    project_id: new_id,
  }));

  await db.transaction(
    "rw",
    [
      db.glossary_entries,
      db.glossary_aliases,
      db.glossary_revisions,
      db.lore_sources,
      db.events,
    ],
    async () => {
      if (remapped_entries.length) {
        await db.glossary_entries.bulkPut(remapped_entries);
      }
      if (remapped_aliases.length) {
        await db.glossary_aliases.bulkPut(remapped_aliases);
      }
      if (remapped_revisions.length) {
        await db.glossary_revisions.bulkPut(remapped_revisions);
      }
      if (remapped_sources.length) {
        await db.lore_sources.bulkPut(remapped_sources);
      }
      await db.events.add({
        project_id: new_id,
        ts: nowMs(),
        kind: "lore.imported",
        payload_json: JSON.stringify({
          source_id: bundle.meta.id,
          entries: remapped_entries.length,
          aliases: remapped_aliases.length,
          schema_version: bundle.schema_version,
        }),
      });
    },
  );

  return {
    lore_id: new_id,
    entries_count: remapped_entries.length,
  };
}

/**
 * Convenience: serialize a bundle for download.
 */
export function serializeLoreBundle(bundle: LoreBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * Convenience: parse a bundle file blob (string or ArrayBuffer).
 */
export function parseLoreBundle(text: string): LoreBundle {
  const data = JSON.parse(text) as LoreBundle;
  return data;
}

/* ------------------------------------------------------------------ */
/* type re-exports for convenience                                     */
/* ------------------------------------------------------------------ */

export type {
  GlossaryAliasRow,
  GlossaryEntryRow,
  GlossaryRevisionRow,
  LoreMetaRow,
  LoreSourceRow,
  ProjectRow,
};
