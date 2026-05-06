/**
 * Settings → Batch reliability card.
 *
 * Surfaces the batch-runner retry / circuit-breaker knobs (see
 * `src/core/batch.ts`'s `BatchRetryConfig` + `BATCH_RETRY_DEFAULTS`).
 *
 * Two layers of resilience:
 *
 * 1. **Per-segment retry.** When a segment fails after the provider's
 *    own retry policy gives up (timeout, persistent CORS / 5xx),
 *    the batch retries the *whole* `translateSegment` call up to
 *    `max_retries_per_segment` times before recording a failure.
 * 2. **Circuit breaker.** A sliding window of the last
 *    `error_window_size` settled segments. If failures inside that
 *    window exceed `max_errors_in_window`, the batch pauses with a
 *    `BatchPaused` error so the curator can fix the root cause
 *    (CORS, model unloaded, timeout too tight) and resume.
 *
 * Defaults live in code (`BATCH_RETRY_DEFAULTS`); leaving every field
 * blank in this card uses them. Clearing all three resets to defaults.
 */

import * as React from "react";
import { RotateCcw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { FieldHelp } from "@/components/ui/field-help";
import { useAppStore } from "@/state/app";
import {
  BATCH_RETRY_DEFAULTS,
  resolveBatchRetryConfig,
} from "@/core/batch";
import type { BatchRetryConfig } from "@/db/schema";

export function BatchReliabilityCard(): React.JSX.Element {
  const llm = useAppStore((s) => s.llm);
  const setLlmConfig = useAppStore((s) => s.setLlmConfig);

  const persisted = React.useMemo(
    () => resolveBatchRetryConfig(llm.batch_retry ?? null),
    [llm.batch_retry],
  );

  // Keep the inputs as strings so partial typing doesn't snap to
  // bounds. We commit on Save (which also clamps via
  // `resolveBatchRetryConfig`).
  const [retries_text, setRetriesText] = React.useState<string>(
    String(persisted.max_retries_per_segment),
  );
  const [window_text, setWindowText] = React.useState<string>(
    String(persisted.error_window_size),
  );
  const [threshold_text, setThresholdText] = React.useState<string>(
    String(persisted.max_errors_in_window),
  );

  React.useEffect(() => {
    setRetriesText(String(persisted.max_retries_per_segment));
    setWindowText(String(persisted.error_window_size));
    setThresholdText(String(persisted.max_errors_in_window));
  }, [persisted]);

  const dirty =
    Number(retries_text) !== persisted.max_retries_per_segment ||
    Number(window_text) !== persisted.error_window_size ||
    Number(threshold_text) !== persisted.max_errors_in_window;

  const reset = (): void => {
    setRetriesText(String(persisted.max_retries_per_segment));
    setWindowText(String(persisted.error_window_size));
    setThresholdText(String(persisted.max_errors_in_window));
  };

  const restoreDefaults = async (): Promise<void> => {
    setRetriesText(String(BATCH_RETRY_DEFAULTS.max_retries_per_segment));
    setWindowText(String(BATCH_RETRY_DEFAULTS.error_window_size));
    setThresholdText(String(BATCH_RETRY_DEFAULTS.max_errors_in_window));
    await setLlmConfig({ batch_retry: null });
    toast.success("Restored built-in defaults.");
  };

  const save = async (): Promise<void> => {
    const draft: BatchRetryConfig = {
      max_retries_per_segment: parseNonNegativeInt(retries_text),
      error_window_size: parsePositiveInt(window_text),
      max_errors_in_window: parsePositiveInt(threshold_text),
    };
    const clamped = resolveBatchRetryConfig(draft);
    await setLlmConfig({ batch_retry: clamped });
    toast.success(
      `Saved · retries ${clamped.max_retries_per_segment}, ` +
        `breaker ${clamped.max_errors_in_window} of ` +
        `${clamped.error_window_size}.`,
    );
  };

  const using_defaults =
    llm.batch_retry == null ||
    (Object.keys(llm.batch_retry).length === 0 &&
      persisted.max_retries_per_segment ===
        BATCH_RETRY_DEFAULTS.max_retries_per_segment &&
      persisted.error_window_size === BATCH_RETRY_DEFAULTS.error_window_size &&
      persisted.max_errors_in_window ===
        BATCH_RETRY_DEFAULTS.max_errors_in_window);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="size-4" aria-hidden />
          Batch reliability
          {using_defaults ? (
            <Badge variant="secondary" className="ml-1 text-[10px]">
              defaults
            </Badge>
          ) : (
            <Badge variant="outline" className="ml-1 text-[10px]">
              customized
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Per-segment retry and circuit-breaker thresholds for batch
          translation runs. Distinct from the per-request HTTP retry —
          this layer fires when a segment fails after the provider has
          already exhausted its own attempts (e.g. repeated timeouts
          against a slow local Ollama).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1.5">
          <FieldHelp
            htmlFor="batch_retries"
            label="Retries per segment"
            help={
              <>
                <p>
                  Extra attempts per segment after the provider has
                  bubbled a failure. <code>0</code> disables this layer
                  entirely (only the provider retries inside a single
                  call). <code>2</code> (the default) gives each
                  segment 1 normal try + 2 full retries before recording
                  a failure.
                </p>
                <p className="mt-2">
                  Each retry is a fresh <code>translateSegment</code>{" "}
                  call — the prompt is rebuilt, the glossary merge runs
                  again, and an audit row is written so the activity log
                  shows the actual pattern (e.g. <em>timeout → timeout
                  → success</em>).
                </p>
              </>
            }
          />
          <Input
            id="batch_retries"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={retries_text}
            onChange={(e) => setRetriesText(e.target.value)}
            className="font-mono text-xs"
          />
          <p className="text-[11px] leading-snug text-muted-foreground">
            Default <code className="font-mono">{BATCH_RETRY_DEFAULTS.max_retries_per_segment}</code>. Bump for flaky cloud endpoints or warming-up local models.
          </p>
        </div>

        <div className="grid gap-1.5">
          <FieldHelp
            htmlFor="batch_window"
            label="Circuit-breaker window size"
            help={
              <>
                <p>
                  Number of most-recent settled segments the circuit
                  breaker watches. The breaker compares failures{" "}
                  <em>within this window</em> against the failure
                  threshold below.
                </p>
                <p className="mt-2">
                  Larger windows are more forgiving (a brief outage
                  early in the run won't trip the breaker after only a
                  handful of segments). Smaller windows fail-fast,
                  useful during capture / screenshot runs.
                </p>
              </>
            }
          />
          <Input
            id="batch_window"
            type="number"
            inputMode="numeric"
            min={1}
            step={10}
            value={window_text}
            onChange={(e) => setWindowText(e.target.value)}
            className="font-mono text-xs"
          />
          <p className="text-[11px] leading-snug text-muted-foreground">
            Default <code className="font-mono">{BATCH_RETRY_DEFAULTS.error_window_size}</code>. Forced to be at least the failure threshold.
          </p>
        </div>

        <div className="grid gap-1.5">
          <FieldHelp
            htmlFor="batch_threshold"
            label="Failures-in-window threshold"
            help={
              <>
                <p>
                  When the count of failed segments inside the window
                  reaches this number, the batch <em>pauses</em> with a
                  <code className="mx-1">BatchPaused</code> error. Fix
                  the underlying cause (CORS, model unloaded, timeout
                  too tight) and resume — already-translated segments
                  are durable.
                </p>
                <p className="mt-2">
                  Default <code>{BATCH_RETRY_DEFAULTS.max_errors_in_window}</code>{" "}
                  of <code>{BATCH_RETRY_DEFAULTS.error_window_size}</code>:
                  if 10% of recent segments fail, something is
                  structurally wrong and continuing only burns budget.
                </p>
              </>
            }
          />
          <Input
            id="batch_threshold"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={threshold_text}
            onChange={(e) => setThresholdText(e.target.value)}
            className="font-mono text-xs"
          />
          <p className="text-[11px] leading-snug text-muted-foreground">
            Default <code className="font-mono">{BATCH_RETRY_DEFAULTS.max_errors_in_window}</code>. Tighten for fast-fail; loosen for noisy environments.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void restoreDefaults()}
            className="gap-1.5 text-xs"
            title="Wipe customisations and use the built-in defaults."
          >
            <RotateCcw className="size-3.5" /> Use defaults
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => reset()}
            disabled={!dirty}
            className="gap-1.5 text-xs"
          >
            Reset
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={!dirty}
          >
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function parseNonNegativeInt(raw: string): number | undefined {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.trunc(n);
}

function parsePositiveInt(raw: string): number | undefined {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.trunc(n);
}
