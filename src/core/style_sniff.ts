/**
 * Pre-create tone sniff (mirrors `epublate.core.style_sniff`).
 *
 * Reads a small **spread** of translatable segments — head, middle,
 * tail — and asks the helper LLM the same `register` / `audience`
 * question we ask during full intake. The result plugs into
 * {@link suggestStyleProfile} so the dashboard can surface a tone
 * preset shortly after a project is created.
 *
 * Compared to the Python implementation, this module operates on a
 * *project that's already been segmented* (the browser port does the
 * intake parse synchronously inside `runProjectIntake`, so by the time
 * the user's tab is ready we already have segments in the DB). That
 * simplifies the sample-collection step considerably: we just walk
 * `chapters` + `segments`, filter to translatable rows, and keep a
 * head/middle/tail spread.
 *
 * The sniff is best-effort UX:
 * - No retries / backoff — the caller (NewProjectModal) just toasts on
 *   failure and lets the curator pick a profile manually.
 * - Always live (no cache) — the curator's design call decided cost
 *   wasn't an issue at this scale.
 * - Auto-applies the suggestion to `project.style_profile` /
 *   `project.style_guide` when the curator hasn't already customized
 *   the style.
 */

import { listChapters } from "@/db/repo/chapters";
import { openProjectDb } from "@/db/dexie";
import {
  type SegmentRow,
  type IntakeRunRow,
  IntakeRunKind,
} from "@/db/schema";
import { PLACEHOLDER_RE } from "@/formats/epub/segmentation";
import { newId } from "@/lib/id";
import { nowMs } from "@/lib/time";
import {
  buildExtractorMessages,
  DEFAULT_EXTRACTOR_RESPONSE_FORMAT,
  parseExtractorResponse,
} from "@/llm/prompts/extractor";
import type { LLMProvider } from "@/llm/base";
import { estimateCost } from "@/llm/pricing";

import { getProfile, suggestStyleProfile } from "./style";

export const PURPOSE_TONE_SNIFF = "tone_sniff";

export interface SampleStrategy {
  head: number;
  middle: number;
  tail: number;
  max_chars_per_block: number;
  max_total_chars: number;
}

export const DEFAULT_SAMPLE_STRATEGY: SampleStrategy = {
  head: 5,
  middle: 3,
  tail: 2,
  max_chars_per_block: 1500,
  max_total_chars: 12_000,
};

export interface ToneSniffSummary {
  profile: string | null;
  register: string | null;
  audience: string | null;
  sample_block_count: number;
  sample_chars: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  model: string;
  /** True when the suggestion was auto-applied to the project. */
  applied: boolean;
}

export interface SniffToneInput {
  project_id: string;
  source_lang: string;
  target_lang: string;
  provider: LLMProvider;
  helper_model: string;
  sample_strategy?: SampleStrategy;
  /**
   * If true (default), the suggested profile is written to
   * `project.style_profile` only when the project doesn't already have
   * a custom style guide. Set to false to compute the suggestion
   * without writing back.
   */
  auto_apply?: boolean;
}

/**
 * Run the tone sniff against an already-imported project.
 *
 * Throws on hard errors (no segments, LLM rejection); the caller is
 * expected to swallow these as best-effort UX failures.
 */
export async function sniffTone(
  input: SniffToneInput,
): Promise<ToneSniffSummary> {
  const strategy = input.sample_strategy ?? DEFAULT_SAMPLE_STRATEGY;

  const segments = await collectTranslatableSegments(input.project_id);
  if (segments.length === 0) {
    throw new Error("style_sniff: no translatable segments in project");
  }

  const chosen = pickSpread(segments, strategy);
  const { text: sample_text, sample_chars } = buildSampleText(
    chosen,
    strategy,
  );

  const messages = buildExtractorMessages({
    source_lang: input.source_lang,
    target_lang: input.target_lang,
    source_text: sample_text,
    glossary: [],
  });

  const chat = await input.provider.chat({
    model: input.helper_model,
    messages,
    response_format: DEFAULT_EXTRACTOR_RESPONSE_FORMAT,
    temperature: 0,
    seed: 7,
  });
  const trace = parseExtractorResponse(chat.content);
  const profile = suggestStyleProfile({
    register: trace.narrative_register,
    audience: trace.narrative_audience,
  });
  const cost = estimateCost(
    chat.model,
    chat.usage?.prompt_tokens ?? 0,
    chat.usage?.completion_tokens ?? 0,
  );

  let applied = false;
  if (profile && (input.auto_apply ?? true)) {
    applied = await maybeApplyProfile(input.project_id, profile);
  }

  // Audit row so the Intake history screen can show the sniff
  // alongside book intake / pre-pass entries.
  await writeSniffAudit({
    project_id: input.project_id,
    helper_model: chat.model,
    profile,
    register: trace.narrative_register,
    audience: trace.narrative_audience,
    sample_chars,
    sample_block_count: chosen.length,
    prompt_tokens: chat.usage?.prompt_tokens ?? 0,
    completion_tokens: chat.usage?.completion_tokens ?? 0,
    cost_usd: cost,
  });

  return {
    profile,
    register: trace.narrative_register,
    audience: trace.narrative_audience,
    sample_block_count: chosen.length,
    sample_chars,
    prompt_tokens: chat.usage?.prompt_tokens ?? 0,
    completion_tokens: chat.usage?.completion_tokens ?? 0,
    cost_usd: cost,
    model: chat.model,
    applied,
  };
}

// ---------- Collection ----------

async function collectTranslatableSegments(
  projectId: string,
): Promise<SegmentRow[]> {
  const db = openProjectDb(projectId);
  const chapters = await listChapters(projectId);
  const ordered = chapters
    .slice()
    .sort((a, b) => a.spine_idx - b.spine_idx);
  const all: SegmentRow[] = [];
  for (const ch of ordered) {
    const rows = await db.segments
      .where("[chapter_id+idx]")
      .between([ch.id, 0], [ch.id, Infinity])
      .toArray();
    for (const s of rows) {
      const text = stripPlaceholders(s.source_text ?? "").trim();
      if (text.length === 0) continue;
      all.push(s);
    }
  }
  return all;
}

// ---------- Sampling ----------

function pickSpread(
  blocks: readonly SegmentRow[],
  strategy: SampleStrategy,
): SegmentRow[] {
  const total_target = strategy.head + strategy.middle + strategy.tail;
  const n = blocks.length;
  if (n === 0) return [];
  if (n <= total_target) return blocks.slice();

  const head_count = Math.min(strategy.head, n);
  const head = blocks.slice(0, head_count);

  const tail_count = Math.min(strategy.tail, n - head_count);
  const tail = tail_count > 0 ? blocks.slice(n - tail_count) : [];

  const middle_zone =
    tail_count > 0 ? blocks.slice(head_count, n - tail_count) : blocks.slice(head_count);

  const middle: SegmentRow[] = [];
  const middle_count = Math.min(strategy.middle, middle_zone.length);
  if (middle_count > 0) {
    const step = Math.max(1, Math.floor(middle_zone.length / (middle_count + 1)));
    for (let i = 1; i <= middle_count; i++) {
      const idx = Math.min(i * step, middle_zone.length - 1);
      middle.push(middle_zone[idx]);
    }
  }

  // Deduplicate (head/tail/middle can overlap on small books) and
  // re-sort by original position so the helper sees opening → closing.
  const seen = new Set<string>();
  const out: SegmentRow[] = [];
  for (const s of [...head, ...middle, ...tail]) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  const pos = new Map<string, number>();
  blocks.forEach((b, i) => pos.set(b.id, i));
  out.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
  return out;
}

function buildSampleText(
  blocks: readonly SegmentRow[],
  strategy: SampleStrategy,
): { text: string; sample_chars: number } {
  const sep = "\n\n---\n\n";
  const chunks: string[] = [];
  let total = 0;
  for (const block of blocks) {
    let text = stripPlaceholders(block.source_text ?? "").trim();
    if (!text) continue;
    if (text.length > strategy.max_chars_per_block) {
      text = text.slice(0, strategy.max_chars_per_block).trimEnd() + "…";
    }
    if (total + text.length + sep.length > strategy.max_total_chars) break;
    chunks.push(text);
    total += text.length + sep.length;
  }
  if (chunks.length === 0) {
    throw new Error("style_sniff: no usable text in selected blocks");
  }
  const body = chunks.join(sep);
  return { text: body, sample_chars: body.length };
}

function stripPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER_RE, "").replace(/[ \t]+/g, " ");
}

// ---------- Apply / audit ----------

async function maybeApplyProfile(
  projectId: string,
  profileId: string,
): Promise<boolean> {
  const db = openProjectDb(projectId);
  const project = await db.projects.get(projectId);
  if (!project) return false;

  const profile = getProfile(profileId);
  if (!profile) return false;

  // Don't overwrite a curator-authored style guide. Only apply when
  // either the existing guide matches the existing preset's prose
  // (i.e. the curator hasn't customized it) or no guide is set.
  const existing_profile = project.style_profile ?? null;
  const existing_guide = project.style_guide ?? null;
  const existing_template =
    existing_profile != null
      ? (getProfile(existing_profile)?.prompt_block ?? null)
      : null;

  const guide_matches_template =
    existing_guide != null &&
    existing_template != null &&
    existing_guide.trim() === existing_template.trim();

  if (existing_guide != null && !guide_matches_template) {
    return false; // user has customized — leave them alone
  }

  await db.projects.update(projectId, {
    style_profile: profileId,
    style_guide: profile.prompt_block,
  });
  await db.events.add({
    project_id: projectId,
    ts: nowMs(),
    kind: "style.applied",
    payload_json: JSON.stringify({
      profile_id: profileId,
    }),
  });
  return true;
}

interface SniffAuditInput {
  project_id: string;
  helper_model: string;
  profile: string | null;
  register: string | null;
  audience: string | null;
  sample_chars: number;
  sample_block_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
}

async function writeSniffAudit(input: SniffAuditInput): Promise<void> {
  const db = openProjectDb(input.project_id);
  const id = newId();
  const ts = nowMs();
  const summary_json = JSON.stringify({
    profile: input.profile,
    register: input.register,
    audience: input.audience,
    sample_block_count: input.sample_block_count,
    sample_chars: input.sample_chars,
  });
  const row: IntakeRunRow = {
    id,
    project_id: input.project_id,
    chapter_id: null,
    kind: IntakeRunKind.TONE_SNIFF,
    helper_model: input.helper_model,
    started_at: ts,
    finished_at: ts,
    status: "completed",
    chunks: 1,
    cached_chunks: 0,
    proposed_count: 0,
    failed_chunks: 0,
    prompt_tokens: input.prompt_tokens,
    completion_tokens: input.completion_tokens,
    cost_usd: input.cost_usd,
    pov: null,
    tense: null,
    register: input.register,
    audience: input.audience,
    suggested_style_profile: input.profile,
    notes: summary_json,
    curator_notes: null,
    error: null,
  };
  await db.intake_runs.put(row);
  await db.events.add({
    project_id: input.project_id,
    ts,
    kind: "tone_sniff.completed",
    payload_json: summary_json,
  });
}
