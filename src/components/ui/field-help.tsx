/**
 * `FieldHelp` — the inline help-tooltip primitive.
 *
 * Pairs a form `<Label>` with a small `?` button that opens a Radix
 * tooltip carrying long-form help text. This is the canonical pattern
 * for any non-trivial form field in epublate (Settings, Project
 * settings, Reader prompts, Ollama options, retry/circuit-breaker
 * thresholds, …) — see `.cursor/rules/ui-help-tooltips.mdc` for the
 * rationale and when to use it.
 *
 * Usage:
 *
 * ```tsx
 * <FieldHelp
 *   htmlFor="num_ctx"
 *   label="Context window"
 *   help={
 *     <>
 *       Tokens loaded into context. Ollama default is{" "}
 *       <code>2048</code>; bump to <code>8192</code> for chapter-sized
 *       prompts.
 *     </>
 *   }
 * />
 * <Input id="num_ctx" type="number" … />
 * ```
 *
 * Accessibility contract:
 *
 * - The `<label>` is the canonical accessible name for the input.
 * - The help button has its own aria-label (`Show help: <label>`),
 *   distinct from the label text — so `getByLabelText(/<label>/)` in
 *   tests still uniquely returns the input, not the help button.
 * - The tooltip is keyboard-reachable: tab to the help button, the
 *   tooltip opens on focus.
 */

import * as React from "react";
import { HelpCircle } from "lucide-react";

import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface FieldHelpProps {
  /** Form-control id this label points at. */
  htmlFor: string;
  /** Visible label text. Plain string — the accessible name of the input. */
  label: React.ReactNode;
  /**
   * Help-tooltip body. Plain text or React nodes (e.g. a paragraph
   * with inline `<code>` for default values). Keep it short — one or
   * two short paragraphs at most.
   */
  help: React.ReactNode;
  /** Optional badge / status pill rendered next to the label. */
  badge?: React.ReactNode;
  /** Side the tooltip opens on. Defaults to `"left"` to keep it inside cards. */
  side?: "top" | "right" | "bottom" | "left";
  /** Optional class for the wrapper. */
  className?: string;
  /** Pass-through for callers that want a different label size. */
  labelClassName?: string;
}

export function FieldHelp({
  htmlFor,
  label,
  help,
  badge,
  side = "left",
  className,
  labelClassName,
}: FieldHelpProps): React.JSX.Element {
  const accessible_name =
    typeof label === "string"
      ? `Show help: ${label}`
      : "Show help for this field";
  return (
    <div className={cn("flex items-center justify-between gap-2", className)}>
      <Label htmlFor={htmlFor} className={cn("text-xs font-medium", labelClassName)}>
        {label}
        {badge ? <span className="ml-1.5 align-middle">{badge}</span> : null}
      </Label>
      <Tooltip delayDuration={250}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={accessible_name}
            className="text-muted-foreground hover:text-foreground"
          >
            <HelpCircle className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side={side}
          className="max-w-sm text-xs leading-snug"
        >
          {help}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
