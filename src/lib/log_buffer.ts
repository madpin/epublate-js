/**
 * In-memory ring buffer for console output.
 *
 * Mirrors `epublate.app.log_buffer` — the Python TUI keeps the last
 * ~5 000 logger lines in RAM so the Logs screen can show a live tail
 * even when the on-disk events table doesn't capture everything (e.g.
 * stack traces in development, generic warnings, third-party libs).
 *
 * Implementation is a small, dependency-free pub/sub buffer that
 * patches `console.{log,info,warn,error,debug}` exactly once per
 * process lifetime and forwards every call to subscribers in addition
 * to the original console method (so devtools still works).
 *
 * Stored entries are JSON-friendly so the Logs screen can serialize
 * them and we can include the most recent slice in bug reports.
 */

const MAX_ENTRIES = 5000;

export interface LogEntry {
  /** Auto-incrementing ordinal so React lists can `key=` it. */
  seq: number;
  /** Wall-clock timestamp, milliseconds since epoch. */
  ts: number;
  /** Log level name (mirrors the console method). */
  level: "debug" | "info" | "warn" | "error" | "log";
  /** Pretty-printed message: arguments joined with single spaces. */
  message: string;
  /** Source location if cheaply available (always null in production). */
  source?: string | null;
}

type Listener = (entry: LogEntry) => void;

const buffer: LogEntry[] = [];
const listeners = new Set<Listener>();
let next_seq = 1;
let installed = false;

/**
 * Install the console patch. Idempotent — calling it twice is a no-op.
 * Safe to call from `main.tsx` at startup.
 */
export function installConsoleLogBuffer(): void {
  if (installed) return;
  if (typeof console === "undefined") return;
  installed = true;

  const original_log = console.log.bind(console);
  const original_info = console.info.bind(console);
  const original_warn = console.warn.bind(console);
  const original_error = console.error.bind(console);
  const original_debug = console.debug.bind(console);

  const wrap =
    (
      orig: (...args: unknown[]) => void,
      level: LogEntry["level"],
    ): ((...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      try {
        push(level, args);
      } catch {
        // never let log-buffer plumbing break the app
      }
      orig(...args);
    };

  console.log = wrap(original_log, "log");
  console.info = wrap(original_info, "info");
  console.warn = wrap(original_warn, "warn");
  console.error = wrap(original_error, "error");
  console.debug = wrap(original_debug, "debug");
}

/** Emit one entry and notify subscribers. Exposed for tests. */
export function pushLogEntry(
  level: LogEntry["level"],
  message: string,
): void {
  push(level, [message]);
}

function push(level: LogEntry["level"], args: unknown[]): void {
  const entry: LogEntry = {
    seq: next_seq++,
    ts: Date.now(),
    level,
    message: formatArgs(args),
    source: null,
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      // ignored — listener errors must not propagate
    }
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/** Snapshot of the buffer right now. Returns a copy. */
export function getLogBuffer(): readonly LogEntry[] {
  return buffer.slice();
}

/** Clear the buffer. Used by tests and the "Clear" button on the Logs screen. */
export function clearLogBuffer(): void {
  buffer.length = 0;
}

/** Subscribe to new log entries. Returns an unsubscribe function. */
export function subscribeLogBuffer(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
