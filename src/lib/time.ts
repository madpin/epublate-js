/** Unix epoch milliseconds. The Python schema uses seconds (Integer); we store ms because JS Date is ms-native. */
export const nowMs = (): number => Date.now();

/**
 * Render a unix-ms timestamp as a short human-readable string.
 *
 * Used in tables and the recents list. Not localized in v1 — we'll
 * wire `Intl.RelativeTimeFormat` once we have more than two timestamp
 * locations to coordinate.
 */
export function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const date = new Date(ms);
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Render a unix-ms timestamp as ISO-ish "YYYY-MM-DD HH:mm" in local time. */
export function formatStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
