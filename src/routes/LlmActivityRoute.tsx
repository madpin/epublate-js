/**
 * LLM activity screen (mirrors `epublate.app.screens.llm_activity`).
 *
 * Lists every recorded `llm_call` for the active project, newest
 * first, alongside its purpose, model, token counts, cost, cache-hit
 * status, and a "view full request/response" pane. Cache hits are
 * shown distinctly so the curator can sanity-check the cost meter.
 */

import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, Sparkles, Database } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ResizableSplit } from "@/components/ui/resizable-split";
import { libraryDb } from "@/db/library";
import { recentLlmCalls } from "@/db/repo/llm_calls";
import { type LlmCallRow } from "@/db/schema";
import { formatCost, formatTokens } from "@/lib/numbers";
import { formatStamp } from "@/lib/time";
import { cn } from "@/lib/utils";

export function LlmActivityRoute(): React.JSX.Element {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [limit, setLimit] = React.useState(100);

  const project = useLiveQuery(
    async () => libraryDb().projects.get(projectId),
    [projectId],
  );

  const rows = useLiveQuery(
    async () => {
      if (!projectId) return [] as LlmCallRow[];
      return recentLlmCalls(projectId, limit);
    },
    [projectId, limit],
  );

  const totals = React.useMemo(() => {
    if (!rows) return null;
    let cost = 0;
    let prompt = 0;
    let completion = 0;
    let hits = 0;
    let misses = 0;
    let duration_ms_total = 0;
    let duration_samples = 0;
    let duration_ms_max = 0;
    const purposes = new Map<string, number>();
    for (const r of rows) {
      cost += r.cost_usd ?? 0;
      prompt += r.prompt_tokens ?? 0;
      completion += r.completion_tokens ?? 0;
      if (r.cache_hit) hits += 1;
      else misses += 1;
      purposes.set(r.purpose, (purposes.get(r.purpose) ?? 0) + 1);
      // duration_ms is non-indexed; legacy rows return undefined.
      // Only count rows that actually report a measured duration so
      // averages don't get diluted by cache replays / older calls.
      if (typeof r.duration_ms === "number" && r.duration_ms >= 0) {
        duration_ms_total += r.duration_ms;
        duration_samples += 1;
        if (r.duration_ms > duration_ms_max) duration_ms_max = r.duration_ms;
      }
    }
    return {
      cost,
      prompt,
      completion,
      hits,
      misses,
      purposes,
      duration_ms_total,
      duration_samples,
      duration_ms_max,
    };
  }, [rows]);

  const selected = React.useMemo(() => {
    if (!rows || !selectedId) return null;
    return rows.find((r) => r.id === selectedId) ?? null;
  }, [rows, selectedId]);

  return (
    <div className="flex h-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Button asChild size="sm" variant="ghost">
          <Link to={`/project/${projectId}`}>
            <ArrowLeft className="size-3.5" /> Dashboard
          </Link>
        </Button>
        <span className="opacity-50">/</span>
        <span>LLM activity</span>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          <Sparkles className="mr-1 inline size-5 text-primary" /> LLM activity
        </h1>
        <p className="text-sm text-muted-foreground">
          Audit log of every prompt, response, token count, and cost
          for <span className="font-medium">{project?.name ?? "…"}</span>.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        <SummaryCard label="Calls" value={rows ? String(rows.length) : "—"} />
        <SummaryCard
          label="Cache hits"
          value={
            totals
              ? `${totals.hits} (${
                  totals.hits + totals.misses === 0
                    ? "0"
                    : Math.round((totals.hits / (totals.hits + totals.misses)) * 100)
                }%)`
              : "—"
          }
        />
        <SummaryCard
          label="Prompt tok."
          value={totals ? formatTokens(totals.prompt) : "—"}
        />
        <SummaryCard
          label="Completion tok."
          value={totals ? formatTokens(totals.completion) : "—"}
        />
        <SummaryCard
          label="Avg / max latency"
          value={
            totals && totals.duration_samples > 0
              ? `${formatDuration(
                  totals.duration_ms_total / totals.duration_samples,
                )} / ${formatDuration(totals.duration_ms_max)}`
              : "—"
          }
          title={
            totals && totals.duration_samples > 0
              ? `Across ${totals.duration_samples} measured call${
                  totals.duration_samples === 1 ? "" : "s"
                }; cache hits / legacy rows excluded.`
              : undefined
          }
        />
        <SummaryCard
          label="Total cost"
          value={totals ? formatCost(totals.cost) : "—"}
        />
      </div>

      <ResizableSplit
        className="min-h-0 flex-1 gap-1"
        defaultRatio={0.45}
        minRatio={0.25}
        maxRatio={0.75}
        storageKey="llm-activity"
        ariaLabel="Resize call list and detail"
        left={
        <Card className="flex h-full min-h-0 flex-col">
          <CardHeader className="flex flex-row items-end justify-between gap-3">
            <div>
              <CardTitle className="text-base">Recent calls</CardTitle>
              <CardDescription>
                Newest first. Click a row to inspect the request and
                response.
              </CardDescription>
            </div>
            <select
              className="flex h-9 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              <option value={50}>last 50</option>
              <option value={100}>last 100</option>
              <option value={500}>last 500</option>
              <option value={2000}>last 2 000</option>
            </select>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto p-0">
            {!rows ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">
                Loading…
              </div>
            ) : rows.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                No LLM calls yet. Translate a segment to see one here.
              </div>
            ) : (
              <ul className="divide-y border-y">
                {rows.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      className={cn(
                        "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors",
                        selectedId === r.id
                          ? "bg-accent"
                          : "hover:bg-accent/50",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <PurposeBadge purpose={r.purpose} />
                        {r.cache_hit ? (
                          <Badge variant="outline" className="text-[10px]">
                            <Database className="size-3" /> cached
                          </Badge>
                        ) : null}
                        <span className="font-mono text-xs text-muted-foreground">
                          {formatStamp(r.created_at)}
                        </span>
                      </div>
                      <div className="grid grid-cols-4 gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{r.model}</span>
                        <span
                          className="font-mono"
                          title={`prompt ${formatTokens(
                            r.prompt_tokens,
                          )} + completion ${formatTokens(
                            r.completion_tokens,
                          )}`}
                        >
                          <span className="text-foreground/70">in</span>{" "}
                          {formatTokens(r.prompt_tokens)}{" "}
                          <span className="text-foreground/70">out</span>{" "}
                          {formatTokens(r.completion_tokens)}
                        </span>
                        <span
                          className={cn(
                            "font-mono",
                            typeof r.duration_ms === "number"
                              ? ""
                              : "opacity-50",
                          )}
                          title={
                            typeof r.duration_ms === "number"
                              ? `Wall-clock duration of the provider call (${r.duration_ms} ms)`
                              : "No wall-clock duration recorded — cache hit, legacy row, or non-instrumented provider."
                          }
                        >
                          {typeof r.duration_ms === "number"
                            ? formatDuration(r.duration_ms)
                            : r.cache_hit
                              ? "cache"
                              : "—"}
                        </span>
                        <span className="font-mono">
                          {formatCost(r.cost_usd)}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        }
        right={
        <Card className="flex h-full min-h-0 flex-col">
          <CardHeader>
            <CardTitle className="text-base">Detail</CardTitle>
            <CardDescription>
              {selected
                ? "Request payload + response body. Drag the divider on the left to widen this pane."
                : "Pick a call on the left to inspect it."}
            </CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto">
            {selected ? <CallDetail row={selected} /> : null}
          </CardContent>
        </Card>
        }
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border bg-card px-3 py-2" title={title}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-base font-semibold">{value}</div>
    </div>
  );
}

/**
 * Compact wall-clock duration formatter. Mirrors how `gh run view`
 * surfaces job times — sub-second runs get ms precision, longer ones
 * round to the most significant unit so the column stays readable in
 * the recent-calls list.
 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  const m = Math.floor(s / 60);
  const rem_s = Math.round(s - m * 60);
  return `${m}m ${rem_s.toString().padStart(2, "0")}s`;
}

function PurposeBadge({ purpose }: { purpose: string }): React.JSX.Element {
  if (purpose === "translate") {
    return <Badge variant="default">translate</Badge>;
  }
  if (purpose === "extract") {
    return (
      <Badge className="bg-amber-500/15 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300">
        extract
      </Badge>
    );
  }
  return <Badge variant="secondary">{purpose}</Badge>;
}

function CallDetail({ row }: { row: LlmCallRow }): React.JSX.Element {
  const request = React.useMemo(() => prettyJson(row.request_json), [row.request_json]);
  const response = React.useMemo(
    () => prettyJson(row.response_json),
    [row.response_json],
  );
  const prompt_tok = row.prompt_tokens ?? 0;
  const completion_tok = row.completion_tokens ?? 0;
  const total_tok = prompt_tok + completion_tok;
  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <KV label="ID" value={row.id} mono />
        <KV label="Created" value={formatStamp(row.created_at)} />
        <KV label="Model" value={row.model} mono />
        <KV label="Purpose" value={row.purpose} mono />
        <KV
          label="Prompt tokens"
          value={formatTokens(row.prompt_tokens)}
          mono
        />
        <KV
          label="Completion tokens"
          value={formatTokens(row.completion_tokens)}
          mono
        />
        <KV label="Total tokens" value={formatTokens(total_tok)} mono />
        <KV label="Cost" value={formatCost(row.cost_usd)} mono />
        <KV
          label="Duration"
          value={
            typeof row.duration_ms === "number"
              ? `${formatDuration(row.duration_ms)} (${row.duration_ms} ms)`
              : row.cache_hit
                ? "cache replay (no round-trip)"
                : "not measured"
          }
          mono
        />
        <KV label="Cache hit" value={row.cache_hit ? "yes" : "no"} />
        <KV
          label="Cache key"
          value={row.cache_key ?? "—"}
          mono
          truncate
        />
        <KV label="Segment ID" value={row.segment_id ?? "—"} mono truncate />
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Request</span>
          <span className="font-mono normal-case opacity-70">
            {row.request_json
              ? `${row.request_json.length.toLocaleString()} chars`
              : ""}
          </span>
        </div>
        {/* `whitespace-pre-wrap` keeps the formatted JSON readable
            while letting long lines wrap inside the pane; `break-words`
            handles tokens (URLs, base64) that have no whitespace.
            `overflow-y-auto` (not `overflow-auto`) means we never get
            a horizontal scrollbar, which the curator can't reach
            without resizing the divider. The cap is generous so the
            full embedding raw payload (≈ 1 536 floats per vector × N
            vectors) renders without truncation; if it's still long
            the inner pre scrolls. */}
        <pre className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words rounded border bg-muted/40 p-2 font-mono text-[11px] leading-snug">
          {request}
        </pre>
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Response</span>
          <span className="font-mono normal-case opacity-70">
            {row.response_json
              ? `${row.response_json.length.toLocaleString()} chars`
              : ""}
          </span>
        </div>
        <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded border bg-muted/40 p-2 font-mono text-[11px] leading-snug">
          {response}
        </pre>
      </div>
    </div>
  );
}

function KV({
  label,
  value,
  mono,
  truncate,
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "text-xs",
          mono && "font-mono",
          truncate
            ? "overflow-hidden text-ellipsis whitespace-nowrap"
            : "break-words",
        )}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function prettyJson(text: string | null): string {
  if (text === null) return "(null)";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
