import * as React from "react";

import {
  getLogBuffer,
  subscribeLogBuffer,
  type LogEntry,
} from "@/lib/log_buffer";

/**
 * Subscribe a component to the in-memory log buffer.
 *
 * Returns the latest snapshot of all retained entries. The buffer is
 * a single global ring (5 000 entries) so this hook does not allocate
 * a fresh array per render — it simply re-renders when a new entry
 * arrives.
 */
export function useLogBuffer(): readonly LogEntry[] {
  const [snapshot, setSnapshot] = React.useState<readonly LogEntry[]>(() =>
    getLogBuffer(),
  );

  React.useEffect(() => {
    setSnapshot(getLogBuffer());
    return subscribeLogBuffer(() => setSnapshot(getLogBuffer()));
  }, []);

  return snapshot;
}
