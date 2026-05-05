/**
 * Logs screen (mirrors `epublate.app.screens.logs`).
 *
 * Three streams in one place:
 *
 * 1. **Events** — `events` table rows (batch.completed, segment.flagged,
 *    intake.completed, …). The system's structured audit trail.
 * 2. **In-memory log** — last 5 000 console lines captured by
 *    `lib/log_buffer`. Useful for debugging warnings/errors that don't
 *    produce a structured event.
 * 3. **LLM calls** — recent prompts/responses with quick links into
 *    the LLM activity screen so a curator can pivot from a
 *    `batch.segment_failed` event to the request body that triggered it.
 *
 * Each stream is filterable; events also filter by kind.
 */

import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  Logs as LogsIcon,
  Sparkles,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { libraryDb } from "@/db/library";
import { openProjectDb } from "@/db/dexie";
import { recentLlmCalls } from "@/db/repo/llm_calls";
import { type EventRow, type LlmCallRow } from "@/db/schema";
import { useLogBuffer } from "@/hooks/useLogBuffer";
import { clearLogBuffer, type LogEntry } from "@/lib/log_buffer";
import { formatCost, formatTokens } from "@/lib/numbers";
import { formatStamp } from "@/lib/time";
import { cn } from "@/lib/utils";

export function LogsRoute(): React.JSX.Element {
  const { projectId = "" } = useParams<{ projectId: string }>();

  const project = useLiveQuery(
    async () => libraryDb().projects.get(projectId),
    [projectId],
  );

  return (
    <div className="flex h-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Button asChild size="sm" variant="ghost">
          <Link to={`/project/${projectId}`}>
            <ArrowLeft className="size-3.5" /> Dashboard
          </Link>
        </Button>
        <span className="opacity-50">/</span>
        <span>Logs</span>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            <LogsIcon className="mr-1 inline size-5 text-primary" /> Logs
          </h1>
          <p className="text-sm text-muted-foreground">
            Structured event log for{" "}
            <span className="font-medium">{project?.name ?? "…"}</span>.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to={`/project/${projectId}/llm`}>
            <Sparkles className="size-3.5" /> Jump to LLM activity
          </Link>
        </Button>
      </div>

      <Tabs defaultValue="events" className="flex min-h-0 flex-1 flex-col gap-4">
        <TabsList className="self-start">
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="memory">In-memory log</TabsTrigger>
          <TabsTrigger value="llm">LLM calls</TabsTrigger>
        </TabsList>

        <TabsContent value="events" className="min-h-0 flex-1">
          <EventsTab projectId={projectId} />
        </TabsContent>

        <TabsContent value="memory" className="min-h-0 flex-1">
          <MemoryTab />
        </TabsContent>

        <TabsContent value="llm" className="min-h-0 flex-1">
          <LlmCallsTab projectId={projectId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- Events tab ----------

function EventsTab({ projectId }: { projectId: string }): React.JSX.Element {
  const [filter, setFilter] = React.useState("");
  const [kind_filter, setKindFilter] = React.useState<string>("");
  const [limit, setLimit] = React.useState(200);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);

  const events = useLiveQuery(
    async () => {
      if (!projectId) return [] as EventRow[];
      const db = openProjectDb(projectId);
      const rows = await db.events
        .where("project_id")
        .equals(projectId)
        .reverse()
        .sortBy("ts");
      return rows.slice(0, limit);
    },
    [projectId, limit],
  );

  const kinds = React.useMemo(() => {
    if (!events) return [];
    const seen = new Set<string>();
    for (const e of events) seen.add(e.kind);
    return Array.from(seen).sort();
  }, [events]);

  const filtered = React.useMemo(() => {
    if (!events) return null;
    const needle = filter.trim().toLowerCase();
    return events.filter((e) => {
      if (kind_filter && e.kind !== kind_filter) return false;
      if (!needle) return true;
      if (e.kind.toLowerCase().includes(needle)) return true;
      return e.payload_json.toLowerCase().includes(needle);
    });
  }, [events, filter, kind_filter]);

  const selected = React.useMemo(() => {
    if (!filtered || selectedId === null) return null;
    return filtered.find((e) => e.id === selectedId) ?? null;
  }, [filtered, selectedId]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <Input
          placeholder="Filter by text in kind or payload…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          className="flex h-9 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none"
          value={kind_filter}
          onChange={(e) => setKindFilter(e.target.value)}
        >
          <option value="">all kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select
          className="flex h-9 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none"
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
        >
          <option value={100}>last 100</option>
          <option value={200}>last 200</option>
          <option value={1000}>last 1 000</option>
          <option value={10000}>last 10 000</option>
        </select>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_1fr]">
        <Card className="flex min-h-0 flex-col">
          <CardHeader>
            <CardTitle className="text-base">
              {filtered ? `${filtered.length} events` : "Loading…"}
            </CardTitle>
            <CardDescription>Newest first.</CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto p-0">
            {!filtered ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">
                Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                No events match the current filters.
              </div>
            ) : (
              <ul className="divide-y border-y">
                {filtered.map((ev) => (
                  <li key={ev.id ?? `${ev.ts}-${ev.kind}`}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(ev.id ?? null)}
                      className={cn(
                        "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs transition-colors",
                        selectedId === ev.id
                          ? "bg-accent"
                          : "hover:bg-accent/50",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <KindBadge kind={ev.kind} />
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {formatStamp(ev.ts)}
                        </span>
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {summarizePayload(ev.payload_json)}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card className="flex min-h-0 flex-col">
          <CardHeader>
            <CardTitle className="text-base">Detail</CardTitle>
            <CardDescription>
              {selected
                ? "Full event payload."
                : "Pick an event on the left to inspect it."}
            </CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto">
            {selected ? <EventDetail row={selected} /> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ---------- In-memory log tab ----------

function MemoryTab(): React.JSX.Element {
  const entries = useLogBuffer();
  const [filter, setFilter] = React.useState("");
  const [level, setLevel] = React.useState<string>("");

  const filtered = React.useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return entries
      .filter((e) => (level ? e.level === level : true))
      .filter((e) => (needle ? e.message.toLowerCase().includes(needle) : true))
      .slice()
      .reverse();
  }, [entries, filter, level]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <Input
          placeholder="Filter by message…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          className="flex h-9 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          <option value="">all levels</option>
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="info">info</option>
          <option value="log">log</option>
          <option value="debug">debug</option>
        </select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => clearLogBuffer()}
          title="Clear in-memory log buffer"
        >
          <Trash2 className="size-3.5" /> Clear
        </Button>
      </div>

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader>
          <CardTitle className="text-base">
            {filtered.length} line{filtered.length === 1 ? "" : "s"}
          </CardTitle>
          <CardDescription>
            Captured from the browser console. Newest first. Cleared when
            the tab reloads.
          </CardDescription>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto p-0">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No console output yet — try translating a segment.
            </div>
          ) : (
            <ul className="divide-y border-y">
              {filtered.map((e) => (
                <li
                  key={e.seq}
                  className="flex items-baseline gap-2 px-3 py-1.5 font-mono text-[11px]"
                >
                  <LevelBadge level={e.level} />
                  <span className="text-[10px] text-muted-foreground">
                    {formatStamp(e.ts)}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 break-all",
                      e.level === "error" && "text-destructive",
                      e.level === "warn" &&
                        "text-amber-700 dark:text-amber-300",
                    )}
                  >
                    {e.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LevelBadge({
  level,
}: {
  level: LogEntry["level"];
}): React.JSX.Element {
  if (level === "error")
    return (
      <Badge className="bg-destructive/15 text-[10px] text-destructive">
        ERR
      </Badge>
    );
  if (level === "warn")
    return (
      <Badge className="bg-amber-500/15 text-[10px] text-amber-700 dark:text-amber-300">
        WARN
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-[10px] uppercase">
      {level}
    </Badge>
  );
}

// ---------- LLM calls tab ----------

function LlmCallsTab({ projectId }: { projectId: string }): React.JSX.Element {
  const [limit, setLimit] = React.useState(50);
  const calls = useLiveQuery(
    async () => recentLlmCalls(projectId, limit),
    [projectId, limit],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          Most recent LLM prompts/responses, oldest at the bottom.
        </div>
        <select
          className="flex h-9 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none"
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
        >
          <option value={25}>last 25</option>
          <option value={50}>last 50</option>
          <option value={200}>last 200</option>
          <option value={1000}>last 1 000</option>
        </select>
      </div>
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader>
          <CardTitle className="text-base">
            {calls ? `${calls.length} calls` : "Loading…"}
          </CardTitle>
          <CardDescription>
            For full inspection (request/response bodies), open the{" "}
            <Link
              to={`/project/${projectId}/llm`}
              className="underline underline-offset-2"
            >
              LLM activity
            </Link>{" "}
            screen.
          </CardDescription>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto p-0">
          {!calls ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              Loading…
            </div>
          ) : calls.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No calls have been recorded for this project yet.
            </div>
          ) : (
            <ul className="divide-y border-y">
              {calls.map((c) => (
                <CallRow key={c.id} row={c} projectId={projectId} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CallRow({
  row,
  projectId,
}: {
  row: LlmCallRow;
  projectId: string;
}): React.JSX.Element {
  const key_short = row.cache_key
    ? `${row.cache_key.slice(0, 12)}…`
    : "(no cache key)";
  const cost = row.cost_usd ?? 0;
  return (
    <li className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-2 px-3 py-1.5 text-xs">
      <Badge variant="outline" className="text-[10px]">
        {row.purpose}
      </Badge>
      <Link
        to={`/project/${projectId}/llm`}
        className="truncate font-mono text-[11px] text-muted-foreground hover:text-foreground"
        title={row.cache_key ?? undefined}
      >
        {row.model} · {key_short}
      </Link>
      <span className="font-mono text-[10px] text-muted-foreground">
        {formatTokens(row.prompt_tokens)}+{formatTokens(row.completion_tokens)}
      </span>
      <span className="text-[10px] text-muted-foreground">
        {row.cache_hit ? "cache" : formatCost(cost)}
      </span>
    </li>
  );
}

// ---------- Shared bits ----------

function KindBadge({ kind }: { kind: string }): React.JSX.Element {
  if (
    kind.startsWith("batch.segment_failed") ||
    kind.endsWith("_failed") ||
    kind.endsWith(".aborted")
  ) {
    return (
      <Badge className="bg-destructive/15 text-destructive hover:bg-destructive/20">
        {kind}
      </Badge>
    );
  }
  if (kind.endsWith(".paused") || kind.endsWith("_rate_limited")) {
    return (
      <Badge className="bg-amber-500/15 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300">
        {kind}
      </Badge>
    );
  }
  if (kind.startsWith("intake.") || kind.startsWith("entity.")) {
    return (
      <Badge variant="secondary" className="text-[10px]">
        {kind}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px]">
      {kind}
    </Badge>
  );
}

function EventDetail({ row }: { row: EventRow }): React.JSX.Element {
  const pretty = React.useMemo(
    () => prettyJson(row.payload_json),
    [row.payload_json],
  );
  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <KV label="ID" value={String(row.id ?? "—")} mono />
        <KV label="Timestamp" value={formatStamp(row.ts)} />
        <KV label="Kind" value={row.kind} mono />
        <KV label="Project" value={row.project_id} mono truncate />
      </div>
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Payload
        </div>
        <pre className="max-h-[60vh] overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] leading-snug">
          {pretty}
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
          truncate && "overflow-hidden text-ellipsis whitespace-nowrap",
        )}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function summarizePayload(json: string): string {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "{}";
    return keys
      .slice(0, 4)
      .map((k) => `${k}=${formatScalar(obj[k])}`)
      .join(" · ");
  } catch {
    return json.slice(0, 120);
  }
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length > 24 ? `${v.slice(0, 21)}…` : v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return String(v);
    if (Number.isInteger(v)) return formatTokens(v);
    return v.toFixed(4);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return Array.isArray(v) ? `[${v.length}]` : "{…}";
}

function prettyJson(text: string | null): string {
  if (text === null) return "(null)";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
