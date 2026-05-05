/**
 * Glossary auto-proposer for translator traces.
 *
 * When the translator returns a `new_entities` array (per the JSON
 * schema in `llm/prompts/translator.ts`), each item is a candidate
 * glossary entry — a name / phrase / term the model thinks the
 * curator should track. The Python tool's pipeline funnels those
 * straight into `upsertProposed` so the lore bible grows naturally
 * as you translate; the browser port hadn't wired this up yet, so
 * the Glossary screen looked frozen even when translations clearly
 * mentioned new characters or places.
 *
 * Hard rules:
 *
 * - Strip and validate every field (the LLM is occasionally
 *   creative with shapes despite the schema).
 * - Cap entity types to `VALID_ENTITY_TYPES`; anything else falls
 *   back to the generic `term` so the upserter can still dedupe.
 * - Skip raw year markers (`1066`, `1939-1945`, `c. 1066`) — the
 *   prompt already tells the LLM not to propose those, but a
 *   defensive filter here prevents a single misbehaving model from
 *   junking the glossary.
 * - Run outside the segment transaction. Each `upsertProposed`
 *   opens its own RW transaction, and we don't want a
 *   `entity.proposed` event to roll back the segment write if the
 *   glossary table somehow errors.
 *
 * The function is intentionally side-effect-only (no return value
 * besides the count) — callers don't need the new ids; `useLiveQuery`
 * over `glossary_entries` handles the UI refresh.
 */

import { openProjectDb } from "@/db/dexie";
import { upsertProposed } from "@/glossary/io";
import type { TranslatorTrace } from "@/llm/prompts/translator";
import type { EntityType } from "@/db/schema";

const VALID_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  "character",
  "place",
  "organization",
  "event",
  "item",
  "date_or_time",
  "phrase",
  "term",
]);

const PURE_YEAR_RE = /^\s*(?:c\.?\s*)?\d{1,4}(?:s|\s*(?:BC|AD|CE|BCE))?\s*$/i;
const YEAR_RANGE_RE = /^\s*\d{1,4}\s*[-–]\s*\d{1,4}\s*$/;

interface ProposeInput {
  project_id: string;
  segment_id: string;
  trace: TranslatorTrace;
  source_lang?: string | null;
  target_lang?: string | null;
}

export interface ProposeOutcome {
  /** Entry ids that did not exist before this call. */
  created_entry_ids: string[];
  /** Entry ids that matched an existing row (post-dedupe). */
  matched_entry_ids: string[];
}

/**
 * Promote the translator's `trace.new_entities` into proposed
 * glossary rows. Best-effort — failures are logged through the
 * project event stream but never bubble up.
 *
 * Returns the entry ids that were freshly created (so the caller can
 * record an `entity_mention` row for the segment that introduced
 * them — without that, the segment that *caused* the entry to exist
 * never shows up under "occurrences", which felt like a bug to
 * curators).
 */
export async function autoProposeFromTranslatorTrace(
  input: ProposeInput,
): Promise<ProposeOutcome> {
  const outcome: ProposeOutcome = {
    created_entry_ids: [],
    matched_entry_ids: [],
  };
  if (!input.trace.new_entities?.length) return outcome;

  for (const raw of input.trace.new_entities) {
    const norm = normalize(raw);
    if (!norm) continue;
    try {
      const result = await upsertProposed(input.project_id, {
        source_term: norm.source,
        type: norm.type,
        first_seen_segment_id: input.segment_id,
        notes: norm.evidence,
        target_term: norm.target,
        source_lang: input.source_lang ?? null,
        target_lang: input.target_lang ?? null,
      });
      if (result.created) {
        outcome.created_entry_ids.push(result.entry_id);
        await appendProposedEvent({
          project_id: input.project_id,
          entry_id: result.entry_id,
          segment_id: input.segment_id,
          source_term: norm.source,
          type: norm.type,
        });
      } else {
        outcome.matched_entry_ids.push(result.entry_id);
      }
    } catch {
      // Glossary upsert is best-effort; the segment write already
      // committed and we don't want a propose-step error to surface
      // as a translation failure.
    }
  }
  return outcome;
}

interface NormalizedCandidate {
  source: string;
  target: string | null;
  type: EntityType;
  evidence: string | null;
}

function normalize(raw: Record<string, unknown>): NormalizedCandidate | null {
  const source = stringField(raw.source);
  if (!source) return null;
  if (PURE_YEAR_RE.test(source) || YEAR_RANGE_RE.test(source)) return null;
  const candidate = stringField(raw.type)?.toLowerCase() ?? "term";
  const type: EntityType = VALID_ENTITY_TYPES.has(candidate as EntityType)
    ? (candidate as EntityType)
    : "term";
  const target = stringField(raw.target);
  const evidence = stringField(raw.evidence);
  return {
    source,
    target: target && target !== source ? target : null,
    type,
    evidence,
  };
}

function stringField(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

interface ProposedEventInput {
  project_id: string;
  entry_id: string;
  segment_id: string;
  source_term: string;
  type: EntityType;
}

async function appendProposedEvent(input: ProposedEventInput): Promise<void> {
  const db = openProjectDb(input.project_id);
  try {
    await db.events.add({
      project_id: input.project_id,
      ts: Date.now(),
      kind: "entity.proposed",
      payload_json: JSON.stringify({
        entry_id: input.entry_id,
        segment_id: input.segment_id,
        source_term: input.source_term,
        type: input.type,
        source: "translator",
      }),
    });
  } catch {
    // Mirror translator-trace error handling: the glossary row is the
    // source of truth, the event is purely informational. A stale
    // event row never blocks a retry.
  }
}
