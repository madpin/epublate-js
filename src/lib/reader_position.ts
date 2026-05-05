/**
 * Per-project Reader position persistence.
 *
 * Why localStorage?
 *
 *   "Where the curator was last reading" is browser-local UI state,
 *   not project data — the same browser on the same machine should
 *   restore it; an exported project bundle should *not* carry it.
 *   That maps cleanly onto `localStorage`, which also keeps the
 *   write path off the Dexie hot path (we'd otherwise be writing on
 *   every scroll event).
 *
 * Stored shape, JSON-encoded under the key `epublate-reader-<pid>`:
 *
 * ```json
 * {
 *   "chapter_id": "ch_abc",
 *   "active_segment_id": "seg_xyz",  // nullable
 *   "scroll_top": 1234                // source-pane scroll offset
 * }
 * ```
 *
 * Failures (storage quota, disabled storage, malformed payload) are
 * swallowed silently — losing a position is annoying, breaking the
 * Reader because storage hiccupped is worse.
 */

export interface ReaderPosition {
  chapter_id: string;
  active_segment_id: string | null;
  scroll_top: number;
  /** ms timestamp; lets us GC ancient entries if we ever need to. */
  saved_at: number;
}

function key(project_id: string): string {
  return `epublate-reader-${project_id}`;
}

export function loadReaderPosition(
  project_id: string,
): ReaderPosition | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(key(project_id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReaderPosition>;
    if (!parsed || typeof parsed.chapter_id !== "string") return null;
    return {
      chapter_id: parsed.chapter_id,
      active_segment_id:
        typeof parsed.active_segment_id === "string"
          ? parsed.active_segment_id
          : null,
      scroll_top:
        typeof parsed.scroll_top === "number" && Number.isFinite(parsed.scroll_top)
          ? Math.max(0, parsed.scroll_top)
          : 0,
      saved_at:
        typeof parsed.saved_at === "number" ? parsed.saved_at : 0,
    };
  } catch {
    return null;
  }
}

export function saveReaderPosition(
  project_id: string,
  pos: Omit<ReaderPosition, "saved_at">,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    const payload: ReaderPosition = { ...pos, saved_at: Date.now() };
    localStorage.setItem(key(project_id), JSON.stringify(payload));
  } catch {
    // Quota errors etc. — drop on the floor.
  }
}

export function clearReaderPosition(project_id: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(key(project_id));
  } catch {
    // ignore
  }
}
