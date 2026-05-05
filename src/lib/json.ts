/**
 * Stable JSON stringifier — sorts object keys at every level so two
 * structurally-equal payloads produce byte-identical strings.
 *
 * Used for cache keys and audit-log rows where any non-determinism
 * in serialization defeats hashing and diffing. Mirrors the Python
 * tool's use of `json.dumps(..., sort_keys=True)`.
 */

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, sortedReplacer);
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k];
    }
    return sorted;
  }
  return value;
}
