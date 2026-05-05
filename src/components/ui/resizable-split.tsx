/**
 * `ResizableSplit` — drag-to-resize two-pane layout.
 *
 * A lightweight, dependency-free splitter for screens like LLM
 * Activity where the curator wants to expand a "detail" pane at the
 * cost of a "list" pane. Avoids the weight of `react-resizable-panels`
 * because we only need horizontal splits and basic state persistence.
 *
 * Persistence:
 *   When `storageKey` is set we mirror the current ratio (0.05–0.95)
 *   to `localStorage`. The store is intentionally per-key — different
 *   screens can share one component without bleeding state.
 *
 * Accessibility:
 *   The divider is rendered as a `<button role="separator">` with
 *   `aria-orientation="vertical"` + `aria-valuenow`, and supports
 *   ←/→ keyboard nudging (5% per keystroke; 25% with Shift).
 */

import * as React from "react";

import { cn } from "@/lib/utils";

interface ResizableSplitProps {
  left: React.ReactNode;
  right: React.ReactNode;
  /** Initial split ratio (0–1) for the left pane. */
  defaultRatio?: number;
  minRatio?: number;
  maxRatio?: number;
  /** When set, persists the ratio under `epublate-split:<storageKey>`. */
  storageKey?: string;
  className?: string;
  ariaLabel?: string;
}

const DEFAULT_RATIO = 0.45;
const STORAGE_PREFIX = "epublate-split:";

function loadRatio(storageKey: string | undefined): number | null {
  if (!storageKey) return null;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + storageKey);
    if (raw == null) return null;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return null;
    if (parsed <= 0 || parsed >= 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveRatio(storageKey: string | undefined, ratio: number): void {
  if (!storageKey) return;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + storageKey, String(ratio));
  } catch {
    // localStorage can throw in private-mode Safari; the splitter
    // continues to work, just not persisted.
  }
}

export function ResizableSplit({
  left,
  right,
  defaultRatio = DEFAULT_RATIO,
  minRatio = 0.15,
  maxRatio = 0.85,
  storageKey,
  className,
  ariaLabel = "Resize panels",
}: ResizableSplitProps): React.JSX.Element {
  const [ratio, setRatio] = React.useState<number>(
    () => loadRatio(storageKey) ?? defaultRatio,
  );
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const draggingRef = React.useRef(false);

  const clamp = React.useCallback(
    (value: number): number => Math.min(maxRatio, Math.max(minRatio, value)),
    [minRatio, maxRatio],
  );

  const updateRatio = React.useCallback(
    (next: number): void => {
      const clamped = clamp(next);
      setRatio(clamped);
      saveRatio(storageKey, clamped);
    },
    [clamp, storageKey],
  );

  const onPointerMove = React.useCallback(
    (ev: PointerEvent): void => {
      if (!draggingRef.current) return;
      const root = containerRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      if (rect.width <= 0) return;
      const offset = ev.clientX - rect.left;
      updateRatio(offset / rect.width);
    },
    [updateRatio],
  );

  const onPointerUp = React.useCallback((): void => {
    draggingRef.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  React.useEffect(() => {
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  const onPointerDown = (ev: React.PointerEvent<HTMLButtonElement>): void => {
    ev.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLButtonElement>): void => {
    const step = ev.shiftKey ? 0.25 : 0.05;
    if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      updateRatio(ratio - step);
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      updateRatio(ratio + step);
    } else if (ev.key === "Home") {
      ev.preventDefault();
      updateRatio(minRatio);
    } else if (ev.key === "End") {
      ev.preventDefault();
      updateRatio(maxRatio);
    } else if (ev.key === " " || ev.key === "Enter") {
      // Reset to default on Space / Enter.
      ev.preventDefault();
      updateRatio(defaultRatio);
    }
  };

  return (
    <div
      ref={containerRef}
      className={cn("flex min-h-0 min-w-0 items-stretch", className)}
    >
      <div
        className="min-h-0 min-w-0"
        style={{ flex: `${ratio} 1 0%` }}
      >
        {left}
      </div>
      <button
        type="button"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={Math.round(minRatio * 100)}
        aria-valuemax={Math.round(maxRatio * 100)}
        aria-label={ariaLabel}
        title="Drag to resize · ←/→ to nudge · Enter to reset"
        className="group relative mx-0.5 flex w-1.5 shrink-0 cursor-col-resize items-center justify-center rounded-full bg-transparent outline-none transition-colors hover:bg-border focus-visible:bg-ring/40"
      >
        <span className="block h-8 w-0.5 rounded-full bg-border/60 group-hover:bg-foreground/30 group-focus-visible:bg-foreground/50" />
      </button>
      <div
        className="min-h-0 min-w-0"
        style={{ flex: `${1 - ratio} 1 0%` }}
      >
        {right}
      </div>
    </div>
  );
}
