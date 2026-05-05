/**
 * Tiny "last opened project" store, persisted to localStorage.
 *
 * Why this exists: global routes (Settings, Lore Books, Projects list)
 * have no project id in the URL, so the project section in the
 * sidebar would normally collapse the moment the curator clicks
 * "Settings" — disorienting if they were mid-flow inside a book.
 * We remember the most recently active project id and let the
 * sidebar treat it as a fallback, so navigating to Settings still
 * shows "Project ▸ <book name>" and the Reader / Glossary / Inbox
 * shortcuts beneath it.
 *
 * The remembered id is *advisory* — if the project has since been
 * deleted, the AppShell silently degrades to the no-project view via
 * `useLiveQuery` returning `null`.
 *
 * We persist to localStorage rather than IndexedDB because:
 *
 * - It's tiny (one short string).
 * - We need synchronous reads on first paint.
 * - If localStorage isn't available (SSR, privacy mode), the store
 *   still works in memory.
 */

import { create } from "zustand";

const STORAGE_KEY = "epublate.last_project_id";

function readInitial(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

interface LastProjectStore {
  last_project_id: string | null;
  remember(project_id: string | null): void;
  forget(project_id: string): void;
}

export const useLastProjectStore = create<LastProjectStore>()((set, get) => ({
  last_project_id: readInitial(),

  remember(project_id) {
    if (!project_id) return;
    if (get().last_project_id === project_id) return;
    set({ last_project_id: project_id });
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, project_id);
      }
    } catch {
      // localStorage may be disabled (private mode, quota exceeded).
      // The in-memory state still works for the rest of the session.
    }
  },

  forget(project_id) {
    if (get().last_project_id !== project_id) return;
    set({ last_project_id: null });
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // see remember()
    }
  },
}));
