/**
 * `<PromptPreview>` — beautified, transparent renderer for a
 * {@link PreviewSegmentPromptResult}.
 *
 * Powers two surfaces:
 *
 *   - Project Settings → {@link PromptSimulatorCard} (a representative
 *     segment, with a "what-if" toggle bar that overrides the
 *     persisted `prompt_options`).
 *   - Reader → `PromptPreviewPanel` (Phase 4) — focused segment,
 *     same renderer.
 *
 * The component is intentionally **read-only**. It does not call the
 * provider, does not write to the DB, and never mutates curator
 * state. Toggling a what-if knob is the parent's job — the parent
 * re-runs `previewSegmentPrompt` and feeds a fresh `result` in.
 *
 * Layout:
 *
 *   - Header: total prompt tokens, estimated cost, cache-status
 *     badge, system/user split ratio.
 *   - Tabs: <code>System</code> · <code>User</code> · <code>Wire payload</code>.
 *   - Each tab shows the section's text in monospaced, pre-wrapped
 *     form. The wire-payload tab is the JSON literally posted to the
 *     LLM endpoint.
 */

import * as React from "react";
import { Cpu, FileJson, Layers, MessagesSquare, Receipt } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import type { PreviewSegmentPromptResult } from "@/core/pipeline";
import { estimateCost } from "@/llm/pricing";

interface PromptPreviewProps {
  /** Result of `previewSegmentPrompt`. Pass `null` while loading. */
  result: PreviewSegmentPromptResult | null;
  /** Slug used for cost estimates (matches what the live call would use). */
  model: string;
  /** Optional initial tab. Defaults to "system". */
  defaultTab?: "system" | "user" | "wire";
}

export function PromptPreview({
  result,
  model,
  defaultTab = "system",
}: PromptPreviewProps): React.JSX.Element {
  if (!result) {
    return (
      <div className="grid place-items-center gap-1 rounded-md border border-dashed border-muted-foreground/30 px-3 py-12 text-xs text-muted-foreground">
        <Layers className="size-5 opacity-50" />
        <span>Building preview…</span>
      </div>
    );
  }

  const sys_tokens = result.prompt_tokens_by_message[0] ?? 0;
  const user_tokens = result.prompt_tokens_by_message[1] ?? 0;
  const total = result.prompt_tokens || 1;
  const sys_pct = Math.round((sys_tokens / total) * 100);
  const user_pct = 100 - sys_pct;
  const input_cost = estimateCost(model, result.prompt_tokens, 0);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="gap-1 text-[10px]">
            <Cpu className="size-3" />
            <span className="font-mono">{model}</span>
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {result.prompt_tokens.toLocaleString()} prompt tokens
          </Badge>
          <Badge variant="outline" className="gap-1 text-[10px]">
            <Receipt className="size-3" />
            ~${input_cost.toFixed(4)} input
          </Badge>
          <Badge
            variant={result.cache_hit ? "success" : "outline"}
            className="text-[10px]"
          >
            {result.cache_hit ? "cache hit" : "cache miss"}
          </Badge>
        </div>
        <div
          className="flex items-center gap-2 text-[10px] text-muted-foreground"
          title={`System prefix vs user tail. The bigger the system slice, the more tokens stay in the LLM's prefix cache across segments in this chapter.`}
        >
          <span>system {sys_pct}%</span>
          <span aria-hidden="true" className="flex h-1.5 w-32 overflow-hidden rounded-full bg-secondary">
            <span
              className="h-full bg-success/70"
              style={{ width: `${sys_pct}%` }}
            />
            <span
              className="h-full bg-warning/70"
              style={{ width: `${user_pct}%` }}
            />
          </span>
          <span>{user_pct}% user</span>
        </div>
      </div>

      <Tabs defaultValue={defaultTab}>
        <TabsList className="grid grid-cols-3 text-[11px]">
          <TabsTrigger value="system" className="gap-1.5">
            <MessagesSquare className="size-3" />
            System
            <span className="text-[10px] text-muted-foreground">
              · {sys_tokens.toLocaleString()}t
            </span>
          </TabsTrigger>
          <TabsTrigger value="user" className="gap-1.5">
            <MessagesSquare className="size-3" />
            User
            <span className="text-[10px] text-muted-foreground">
              · {user_tokens.toLocaleString()}t
            </span>
          </TabsTrigger>
          <TabsTrigger value="wire" className="gap-1.5">
            <FileJson className="size-3" />
            Wire payload
          </TabsTrigger>
        </TabsList>
        <TabsContent value="system" className="mt-2">
          <PromptCodeBlock
            text={result.system_text}
            empty="(no system message)"
          />
        </TabsContent>
        <TabsContent value="user" className="mt-2">
          <PromptCodeBlock
            text={result.user_text}
            empty="(no user message)"
          />
        </TabsContent>
        <TabsContent value="wire" className="mt-2">
          <PromptCodeBlock
            text={JSON.stringify(
              {
                model,
                messages: result.messages.map((m) => ({
                  role: m.role,
                  content: m.content,
                })),
                response_format: { type: "json_object" },
              },
              null,
              2,
            )}
            empty=""
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PromptCodeBlock({
  text,
  empty,
}: {
  text: string;
  empty: string;
}): React.JSX.Element {
  if (!text.trim()) {
    return (
      <div className="rounded-md border border-dashed border-muted-foreground/30 px-3 py-6 text-center text-xs text-muted-foreground">
        {empty}
      </div>
    );
  }
  // Split on lines so we can render line-numbered gutters; safer than
  // regex-replacing newlines in JSX.
  const lines = text.split("\n");
  return (
    <ScrollArea className="h-[420px] rounded-md border bg-card">
      <pre
        className="m-0 min-w-full font-mono text-[11px] leading-snug"
        aria-label="Prompt content"
      >
        <code>
          {lines.map((line, i) => (
            <div
              key={i}
              className="grid grid-cols-[3rem_1fr] hover:bg-accent/40"
            >
              <span className="select-none border-r border-border/40 bg-muted/30 px-2 text-right text-[10px] text-muted-foreground">
                {i + 1}
              </span>
              <span className="whitespace-pre-wrap break-words px-3 py-0">
                {line || "\u00a0"}
              </span>
            </div>
          ))}
        </code>
      </pre>
    </ScrollArea>
  );
}
