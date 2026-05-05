/**
 * Global in-flight per-segment translation state.
 *
 * Why this exists: when a curator clicks "Translate" on a single
 * segment in the Reader and then navigates away (Dashboard, Glossary,
 * even another chapter via the URL), the underlying `translateSegment`
 * promise is still running — it just no longer has a component to
 * notify when it finishes. The local `useState<Set<string>>` we used
 * to track the spinner therefore goes silent the moment the Reader
 * unmounts.
 *
 * Hoisting the set into a Zustand store fixes that:
 *
 * - The runner stays the same (`translateSegment(...)`).
 * - The wrapper that toggles "is translating" lives outside the
 *   component, so unmounting the Reader doesn't lose the state.
 * - Coming back to the Reader (or to the Dashboard's per-chapter
 *   progress, or to the Inbox) reads the same set and shows the
 *   pending segments as still-translating.
 *
 * The store is **process-scoped, not persisted**. A page reload
 * cancels in-flight fetches anyway, so a fresh empty set is the
 * correct state on boot.
 */

import { create } from "zustand";

interface TranslatingStore {
  /** project_id → segment_ids currently in flight. */
  by_project: Record<string, Set<string>>;
  add(project_id: string, segment_id: string): void;
  remove(project_id: string, segment_id: string): void;
  clearProject(project_id: string): void;
  /** Read-only snapshot of in-flight segments for a project. */
  snapshot(project_id: string): ReadonlySet<string>;
}

export const useTranslatingStore = create<TranslatingStore>()((set, get) => ({
  by_project: {},

  add(project_id, segment_id) {
    set((state) => {
      const cur = state.by_project[project_id] ?? new Set<string>();
      if (cur.has(segment_id)) return state;
      const next_set = new Set(cur);
      next_set.add(segment_id);
      return {
        by_project: { ...state.by_project, [project_id]: next_set },
      };
    });
  },

  remove(project_id, segment_id) {
    set((state) => {
      const cur = state.by_project[project_id];
      if (!cur || !cur.has(segment_id)) return state;
      const next_set = new Set(cur);
      next_set.delete(segment_id);
      const next_by_project = { ...state.by_project };
      if (next_set.size === 0) {
        delete next_by_project[project_id];
      } else {
        next_by_project[project_id] = next_set;
      }
      return { by_project: next_by_project };
    });
  },

  clearProject(project_id) {
    set((state) => {
      if (!state.by_project[project_id]) return state;
      const next_by_project = { ...state.by_project };
      delete next_by_project[project_id];
      return { by_project: next_by_project };
    });
  },

  snapshot(project_id) {
    return get().by_project[project_id] ?? EMPTY;
  },
}));

const EMPTY: ReadonlySet<string> = new Set();

/**
 * React-friendly selector that returns a stable reference for the
 * project's in-flight set. Components subscribe via:
 *
 * ```ts
 * const translating = useTranslatingStore(translatingForProject(project_id));
 * ```
 *
 * which only re-renders when *that project's* set actually changes.
 */
export function translatingForProject(
  project_id: string,
): (state: { by_project: Record<string, Set<string>> }) => ReadonlySet<string> {
  return (state) => state.by_project[project_id] ?? EMPTY;
}
