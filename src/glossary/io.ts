/**
 * Glossary import/export and auto-proposal upsert
 * (mirrors `epublate.glossary.io`).
 *
 * Three entry points:
 * - `exportJson(projectId)` — deterministic JSON snapshot of every
 *   glossary entry in the project.
 * - `importJson(projectId, payload, conflict)` — apply a snapshot
 *   with `skip` or `overwrite` semantics.
 * - `upsertProposed(projectId, …)` — auto-proposer's dedupe-aware
 *   inserter for new candidates from the translator.
 */

import {
  createGlossaryEntry,
  findGlossaryEntryBySourceTerm,
  listGlossaryEntries,
  setAliases,
  updateGlossaryEntry,
} from "@/db/repo/glossary";
import { canonicalForm } from "./dedup";
import type {
  GlossaryEntryWithAliases,
  GlossaryStatusLiteral,
} from "./models";
import { normalizeTerm } from "./normalize";
import type { EntityType, GenderTag } from "@/db/schema";

export const GLOSSARY_FORMAT_VERSION = 2;
const SUPPORTED_FORMAT_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

export type ConflictStrategy = "skip" | "overwrite";

export interface ImportSummary {
  created: number;
  updated: number;
  skipped: number;
}

export interface GlossaryExportPayload {
  version: number;
  project_id: string;
  entries: GlossaryExportEntry[];
}

export interface GlossaryExportEntry {
  source_term: string | null;
  target_term: string;
  type: EntityType;
  status: GlossaryStatusLiteral;
  gender: GenderTag | null;
  notes: string | null;
  source_known: boolean;
  source_aliases: string[];
  target_aliases: string[];
}

const VALID_TYPES: ReadonlySet<string> = new Set([
  "character",
  "place",
  "organization",
  "event",
  "item",
  "date_or_time",
  "phrase",
  "term",
  "other",
]);
const VALID_STATUSES: ReadonlySet<string> = new Set([
  "proposed",
  "confirmed",
  "locked",
]);
const VALID_GENDERS: ReadonlySet<string> = new Set([
  "feminine",
  "masculine",
  "neuter",
  "common",
  "unspecified",
]);

export class GlossaryConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlossaryConfigurationError";
  }
}

function entryToPayload(entry: GlossaryEntryWithAliases): GlossaryExportEntry {
  return {
    source_term: entry.entry.source_term,
    target_term: entry.entry.target_term,
    type: entry.entry.type,
    status: entry.entry.status,
    gender: entry.entry.gender,
    notes: entry.entry.notes,
    source_known: entry.entry.source_known,
    source_aliases: [...entry.source_aliases],
    target_aliases: [...entry.target_aliases],
  };
}

export async function exportJson(
  projectId: string,
): Promise<GlossaryExportPayload> {
  const entries = await listGlossaryEntries(projectId);
  return {
    version: GLOSSARY_FORMAT_VERSION,
    project_id: projectId,
    entries: entries.map(entryToPayload),
  };
}

interface NormalizedEntry {
  source_term: string | null;
  target_term: string;
  type: EntityType;
  status: GlossaryStatusLiteral;
  gender: GenderTag | null;
  notes: string | null;
  source_known: boolean;
  source_aliases: string[];
  target_aliases: string[];
}

export async function importJson(
  projectId: string,
  payload: unknown,
  opts: { conflict?: ConflictStrategy } = {},
): Promise<ImportSummary> {
  const conflict = opts.conflict ?? "skip";
  const data = validatePayloadShape(payload);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const raw of data.entries) {
    const normalized = normalizeEntryPayload(raw);
    let existing:
      | { id: string }
      | undefined;
    if (normalized.source_term === null) {
      existing = undefined;
    } else {
      const found = await findGlossaryEntryBySourceTerm(
        projectId,
        normalized.source_term,
        normalized.type,
      );
      existing = found ? { id: found.id } : undefined;
    }
    if (!existing) {
      await createGlossaryEntry(projectId, {
        project_id: projectId,
        source_term: normalized.source_term,
        target_term: normalized.target_term,
        type: normalized.type,
        status: normalized.status,
        gender: normalized.gender,
        notes: normalized.notes,
        source_aliases: normalized.source_aliases,
        target_aliases: normalized.target_aliases,
        source_known: normalized.source_known,
      });
      created += 1;
      continue;
    }

    if (conflict === "skip") {
      skipped += 1;
      continue;
    }

    await updateGlossaryEntry(projectId, existing.id, {
      target_term: normalized.target_term,
      status: normalized.status,
      type: normalized.type,
      gender: normalized.gender,
      notes: normalized.notes,
      reason: "import_json:overwrite",
    });
    await setAliases(projectId, existing.id, {
      source_aliases: normalized.source_aliases,
      target_aliases: normalized.target_aliases,
    });
    updated += 1;
  }

  return { created, updated, skipped };
}

export interface UpsertProposedInput {
  source_term: string;
  type?: EntityType;
  notes?: string | null;
  first_seen_segment_id?: string | null;
  target_term?: string | null;
  source_lang?: string | null;
  target_lang?: string | null;
}

/**
 * Insert a `proposed` entry if no row exists yet for this source term.
 * Returns `{ entry_id, created }` so the pipeline can decide whether
 * to emit an `entity.proposed` event (only on first sighting).
 *
 * Mirrors `upsert_proposed` semantics:
 * - Lookup keyed by `source_term` alone (ignore type — auto-proposer
 *   is unreliable about the type field).
 * - Canonical-form fallback: if exact lookup misses, scan the
 *   project's glossary and match via `canonicalForm` so well-known
 *   near-duplicates land on the existing row.
 * - Type upgrade: when existing row is `proposed` + generic `term`
 *   and the incoming candidate has a more specific type, upgrade.
 * - Target backfill: if existing row's `target_term === source_term`
 *   (no real translation yet) and caller passes a real translation,
 *   backfill the target.
 * - Lemma-form normalization: when source/target lang are provided,
 *   strip a leading article/preposition from both sides before lookup.
 */
export async function upsertProposed(
  projectId: string,
  input: UpsertProposedInput,
): Promise<{ entry_id: string; created: boolean }> {
  let source_term = input.source_term;
  if (input.source_lang) {
    const norm = normalizeTerm(source_term, { lang: input.source_lang });
    if (norm.particle !== null && norm.stripped) {
      source_term = norm.stripped;
    }
  }
  let cleaned_target = (input.target_term ?? "").trim() || null;
  if (cleaned_target !== null && input.target_lang) {
    const norm = normalizeTerm(cleaned_target, { lang: input.target_lang });
    if (norm.particle !== null && norm.stripped) {
      cleaned_target = norm.stripped;
    }
  }
  if (cleaned_target !== null && cleaned_target === source_term) {
    cleaned_target = null;
  }

  const exact = await findGlossaryEntryBySourceTerm(projectId, source_term);
  let canonicalMatch: GlossaryEntryWithAliases | undefined;
  let existing = exact;
  if (!existing) {
    const targetCanonical = canonicalForm(source_term);
    if (targetCanonical) {
      const all = await listGlossaryEntries(projectId);
      for (const candidate of all) {
        if (!candidate.entry.source_term) continue;
        if (canonicalForm(candidate.entry.source_term) === targetCanonical) {
          canonicalMatch = candidate;
          break;
        }
      }
    }
  }
  if (!existing && canonicalMatch) {
    existing = canonicalMatch.entry;
    if (
      source_term.toLowerCase() !==
        (canonicalMatch.entry.source_term ?? "").toLowerCase() &&
      !canonicalMatch.source_aliases.includes(source_term)
    ) {
      await setAliases(projectId, canonicalMatch.entry.id, {
        source_aliases: [...canonicalMatch.source_aliases, source_term],
        target_aliases: canonicalMatch.target_aliases,
      });
    }
  }

  const type: EntityType = input.type ?? "term";

  if (existing) {
    const upgrade_type =
      existing.status === "proposed" &&
      existing.type === "term" &&
      type !== "term";
    const backfill_target =
      cleaned_target !== null &&
      existing.status === "proposed" &&
      existing.target_term === existing.source_term;
    if (upgrade_type || backfill_target) {
      await updateGlossaryEntry(projectId, existing.id, {
        target_term: backfill_target && cleaned_target !== null
          ? cleaned_target
          : undefined,
        type: upgrade_type ? type : undefined,
        reason: upsertReason({ upgrade_type, backfill_target }),
      });
    }
    return { entry_id: existing.id, created: false };
  }

  const ent = await createGlossaryEntry(projectId, {
    project_id: projectId,
    source_term,
    target_term: cleaned_target ?? source_term,
    type,
    status: "proposed",
    notes: input.notes ?? null,
    first_seen_segment_id: input.first_seen_segment_id ?? null,
  });
  return { entry_id: ent.entry.id, created: true };
}

function upsertReason(opts: {
  upgrade_type: boolean;
  backfill_target: boolean;
}): string {
  if (opts.upgrade_type && opts.backfill_target) {
    return "auto_propose:upgrade_type+backfill_target";
  }
  if (opts.upgrade_type) return "auto_propose:upgrade_type";
  return "auto_propose:backfill_target";
}

interface ValidatedPayload {
  version: number;
  entries: unknown[];
}

function validatePayloadShape(payload: unknown): ValidatedPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new GlossaryConfigurationError(
      "glossary payload must be a JSON object",
    );
  }
  const obj = payload as Record<string, unknown>;
  const version = obj.version;
  if (typeof version !== "number" || !SUPPORTED_FORMAT_VERSIONS.has(version)) {
    throw new GlossaryConfigurationError(
      `unsupported glossary file version: ${JSON.stringify(version)} ` +
        `(supported: [${[...SUPPORTED_FORMAT_VERSIONS].sort().join(", ")}])`,
    );
  }
  const entries = obj.entries;
  if (!Array.isArray(entries)) {
    throw new GlossaryConfigurationError(
      "glossary payload 'entries' must be a list",
    );
  }
  return { version, entries };
}

function normalizeEntryPayload(raw: unknown): NormalizedEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GlossaryConfigurationError(
      "each glossary entry must be a JSON object",
    );
  }
  const obj = raw as Record<string, unknown>;
  const target_term = obj.target_term;
  if (typeof target_term !== "string" || !target_term.trim()) {
    throw new GlossaryConfigurationError(
      "entry missing non-empty 'target_term'",
    );
  }
  const raw_known = obj.source_known;
  let source_known: boolean;
  if (raw_known === undefined || raw_known === null) source_known = true;
  else if (typeof raw_known === "boolean") source_known = raw_known;
  else if (typeof raw_known === "number") source_known = raw_known !== 0;
  else {
    throw new GlossaryConfigurationError(
      "entry 'source_known' must be a boolean if set",
    );
  }
  const raw_source = obj.source_term;
  let source_term: string | null;
  if (raw_source === null || raw_source === undefined) {
    if (source_known) {
      throw new GlossaryConfigurationError(
        "entry missing non-empty 'source_term'; " +
          "set 'source_known': false to author a target-only entry",
      );
    }
    source_term = null;
  } else if (typeof raw_source !== "string" || !raw_source.trim()) {
    throw new GlossaryConfigurationError(
      "entry 'source_term' must be a non-empty string",
    );
  } else {
    source_term = raw_source;
  }
  const label = source_term ?? target_term;

  const type_str = String(obj.type ?? "term");
  if (!VALID_TYPES.has(type_str)) {
    throw new GlossaryConfigurationError(
      `entry '${label}' has invalid type '${type_str}'; ` +
        `expected one of [${[...VALID_TYPES].sort().join(", ")}]`,
    );
  }
  const status_str = String(obj.status ?? "proposed");
  if (!VALID_STATUSES.has(status_str)) {
    throw new GlossaryConfigurationError(
      `entry '${label}' has invalid status '${status_str}'; ` +
        `expected one of [${[...VALID_STATUSES].sort().join(", ")}]`,
    );
  }

  const gender_raw = obj.gender;
  let gender: GenderTag | null = null;
  if (gender_raw !== null && gender_raw !== undefined) {
    const gs = String(gender_raw);
    if (!VALID_GENDERS.has(gs)) {
      throw new GlossaryConfigurationError(
        `entry '${label}' has invalid gender '${gs}'; ` +
          `expected one of [${[...VALID_GENDERS].sort().join(", ")}, null]`,
      );
    }
    gender = gs as GenderTag;
  }

  const notes_raw = obj.notes;
  let notes: string | null = null;
  if (notes_raw !== null && notes_raw !== undefined) {
    if (typeof notes_raw !== "string") {
      throw new GlossaryConfigurationError(
        `entry '${label}' 'notes' must be a string if set`,
      );
    }
    notes = notes_raw;
  }
  const src_aliases = coerceAliasList(obj.source_aliases ?? [], label);
  const tgt_aliases = coerceAliasList(obj.target_aliases ?? [], label);

  return {
    source_term,
    target_term,
    type: type_str as EntityType,
    status: status_str as GlossaryStatusLiteral,
    gender,
    notes,
    source_known,
    source_aliases: src_aliases,
    target_aliases: tgt_aliases,
  };
}

function coerceAliasList(raw: unknown, owner: string): string[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new GlossaryConfigurationError(
      `entry '${owner}': alias lists must be JSON arrays`,
    );
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new GlossaryConfigurationError(
        `entry '${owner}': aliases must be strings`,
      );
    }
    if (item.trim()) out.push(item);
  }
  return out;
}

// ---------- CSV ----------

const CSV_HEADERS = [
  "source_term",
  "target_term",
  "type",
  "status",
  "gender",
  "notes",
  "source_known",
  "source_aliases",
  "target_aliases",
] as const;

/**
 * Render glossary entries as CSV.
 *
 * Aliases are joined with `;`. Fields are quoted with `"` and inner
 * quotes are doubled (RFC 4180).
 */
export function exportCsv(entries: readonly GlossaryEntryWithAliases[]): string {
  const lines: string[] = [CSV_HEADERS.join(",")];
  for (const ent of entries) {
    const row = [
      ent.entry.source_term ?? "",
      ent.entry.target_term,
      ent.entry.type,
      ent.entry.status,
      ent.entry.gender ?? "",
      ent.entry.notes ?? "",
      ent.entry.source_known ? "true" : "false",
      ent.source_aliases.join(";"),
      ent.target_aliases.join(";"),
    ];
    lines.push(row.map(csvEscape).join(","));
  }
  return lines.join("\n") + "\n";
}

function csvEscape(field: string): string {
  if (/[",\n\r]/.test(field)) {
    return `"${field.replace(/"/gu, '""')}"`;
  }
  return field;
}

/**
 * Parse a glossary CSV (mirror of `exportCsv`'s header/format) into a
 * v2 payload that `importJson` understands.
 */
export function parseCsv(text: string): GlossaryExportPayload {
  const rows = parseCsvRows(text);
  if (!rows.length) {
    return {
      version: GLOSSARY_FORMAT_VERSION,
      project_id: "",
      entries: [],
    };
  }
  const header = rows[0]!.map((h) => h.trim());
  for (const required of CSV_HEADERS) {
    if (!header.includes(required)) {
      throw new GlossaryConfigurationError(
        `CSV missing required column: '${required}'`,
      );
    }
  }
  const idx = (key: (typeof CSV_HEADERS)[number]): number => header.indexOf(key);
  const entries: GlossaryExportEntry[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.length === 1 && row[0]!.trim() === "") continue;
    const sourceTermRaw = row[idx("source_term")] ?? "";
    const sourceKnownRaw = (row[idx("source_known")] ?? "true").toLowerCase();
    const source_known = sourceKnownRaw === "true" || sourceKnownRaw === "1";
    const source_term = sourceTermRaw.trim()
      ? sourceTermRaw
      : source_known
        ? sourceTermRaw
        : null;
    if (source_known && (!sourceTermRaw || !sourceTermRaw.trim())) {
      throw new GlossaryConfigurationError(
        `row ${i + 1}: source_known=true but source_term is empty`,
      );
    }
    const target_term = (row[idx("target_term")] ?? "").trim();
    if (!target_term) {
      throw new GlossaryConfigurationError(
        `row ${i + 1}: target_term must be non-empty`,
      );
    }
    const type_str = (row[idx("type")] ?? "term").trim() || "term";
    const status_str = (row[idx("status")] ?? "proposed").trim() || "proposed";
    const gender_str = (row[idx("gender")] ?? "").trim();
    const notes_str = (row[idx("notes")] ?? "").trim();
    const src_aliases_str = (row[idx("source_aliases")] ?? "").trim();
    const tgt_aliases_str = (row[idx("target_aliases")] ?? "").trim();
    if (!VALID_TYPES.has(type_str)) {
      throw new GlossaryConfigurationError(
        `row ${i + 1}: invalid type '${type_str}'`,
      );
    }
    if (!VALID_STATUSES.has(status_str)) {
      throw new GlossaryConfigurationError(
        `row ${i + 1}: invalid status '${status_str}'`,
      );
    }
    if (gender_str && !VALID_GENDERS.has(gender_str)) {
      throw new GlossaryConfigurationError(
        `row ${i + 1}: invalid gender '${gender_str}'`,
      );
    }
    entries.push({
      source_term,
      target_term,
      type: type_str as EntityType,
      status: status_str as GlossaryStatusLiteral,
      gender: gender_str ? (gender_str as GenderTag) : null,
      notes: notes_str || null,
      source_known,
      source_aliases: src_aliases_str
        ? src_aliases_str.split(";").map((s) => s.trim()).filter(Boolean)
        : [],
      target_aliases: tgt_aliases_str
        ? tgt_aliases_str.split(";").map((s) => s.trim()).filter(Boolean)
        : [],
    });
  }
  return {
    version: GLOSSARY_FORMAT_VERSION,
    project_id: "",
    entries,
  };
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch === "\r") {
      // swallow — CRLF handled by the next iteration's \n
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
