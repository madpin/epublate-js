/**
 * Top-level "library" Dexie DB.
 *
 * The Python TUI keeps two pieces of multi-project state on disk:
 *   - `~/.config/epublate/recents.json` — list of opened project paths
 *   - `~/.config/epublate/ui.toml`      — theme + auto-tone-sniff toggle
 *
 * Their browser-port equivalent lives in **one** Dexie database
 * (`epublate-library`) so the Projects landing screen can render the
 * recents list, theme, and resolved LLM config without opening any
 * per-project DB.
 *
 * Per-project data lives in *separate* Dexie DBs named
 * `epublate-project-<id>`; per-Lore-Book data lives in
 * `epublate-lore-<id>`. Deleting a project is a single
 * `Dexie.delete(name)` call.
 */

import Dexie, { type Table } from "dexie";

import {
  type LibraryLlmConfigRow,
  type LibraryLoreBookRow,
  type LibraryProjectRow,
  type LibraryUiPrefsRow,
  type ThemeIdT,
  ThemeId,
} from "./schema";

const DB_NAME = "epublate-library";

export class LibraryDb extends Dexie {
  projects!: Table<LibraryProjectRow, string>;
  loreBooks!: Table<LibraryLoreBookRow, string>;
  ui!: Table<LibraryUiPrefsRow, "prefs">;
  llm!: Table<LibraryLlmConfigRow, "llm">;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      projects: "id, opened_at, created_at, name",
      loreBooks: "id, opened_at, created_at, name",
      ui: "key",
      llm: "key",
    });
  }
}

let _db: LibraryDb | null = null;

/** Lazy singleton — Dexie connects on first table access. */
export function libraryDb(): LibraryDb {
  if (_db === null) _db = new LibraryDb();
  return _db;
}

/**
 * Drop the cached singleton so the next `libraryDb()` re-opens the DB.
 *
 * Tests call this after deleting the underlying database to avoid
 * `DatabaseClosedError` on subsequent reads.
 */
export function resetLibraryDbCache(): void {
  if (_db !== null) {
    try {
      _db.close();
    } catch {
      // ignore
    }
    _db = null;
  }
}

/** UI preferences singleton with sensible defaults if no row exists yet. */
export const DEFAULT_UI_PREFS: LibraryUiPrefsRow = {
  key: "prefs",
  theme: ThemeId.EPUBLATE,
  auto_tone_sniff: true,
  last_source_filename: null,
  default_budget_usd: null,
  default_concurrency: 4,
  last_source_lang: null,
  last_target_lang: null,
};

export async function readUiPrefs(): Promise<LibraryUiPrefsRow> {
  const row = await libraryDb().ui.get("prefs");
  return row ?? DEFAULT_UI_PREFS;
}

export async function writeUiPrefs(
  patch: Partial<Omit<LibraryUiPrefsRow, "key">>,
): Promise<LibraryUiPrefsRow> {
  const next: LibraryUiPrefsRow = { ...(await readUiPrefs()), ...patch };
  await libraryDb().ui.put(next);
  return next;
}

export async function setTheme(theme: ThemeIdT): Promise<void> {
  await writeUiPrefs({ theme });
}

/** LLM config singleton — empty defaults so the Settings screen is the source of truth. */
export const DEFAULT_LLM_CONFIG: LibraryLlmConfigRow = {
  key: "llm",
  base_url: "https://api.openai.com/v1",
  api_key: "",
  model: "gpt-5-mini",
  helper_model: null,
  organization: null,
  reasoning_effort: null,
  pricing_overrides: {},
};

export async function readLlmConfig(): Promise<LibraryLlmConfigRow> {
  const row = await libraryDb().llm.get("llm");
  return row ?? DEFAULT_LLM_CONFIG;
}

export async function writeLlmConfig(
  patch: Partial<Omit<LibraryLlmConfigRow, "key">>,
): Promise<LibraryLlmConfigRow> {
  const next: LibraryLlmConfigRow = { ...(await readLlmConfig()), ...patch };
  await libraryDb().llm.put(next);
  return next;
}

export async function listRecentProjects(): Promise<LibraryProjectRow[]> {
  return libraryDb().projects.orderBy("opened_at").reverse().toArray();
}

export async function listLoreBooks(): Promise<LibraryLoreBookRow[]> {
  return libraryDb().loreBooks.orderBy("opened_at").reverse().toArray();
}

export async function upsertLibraryProject(
  row: LibraryProjectRow,
): Promise<void> {
  await libraryDb().projects.put(row);
}

export async function touchLibraryProject(id: string): Promise<void> {
  await libraryDb().projects.update(id, { opened_at: Date.now() });
}

export async function removeLibraryProject(id: string): Promise<void> {
  await libraryDb().projects.delete(id);
}

export async function upsertLibraryLoreBook(
  row: LibraryLoreBookRow,
): Promise<void> {
  await libraryDb().loreBooks.put(row);
}

export async function touchLibraryLoreBook(id: string): Promise<void> {
  await libraryDb().loreBooks.update(id, { opened_at: Date.now() });
}

export async function removeLibraryLoreBook(id: string): Promise<void> {
  await libraryDb().loreBooks.delete(id);
}

/** Friendly DB names for the IDB inspector / debug logs. */
export function projectDbName(projectId: string): string {
  return `epublate-project-${projectId}`;
}

export function loreDbName(loreId: string): string {
  return `epublate-lore-${loreId}`;
}
