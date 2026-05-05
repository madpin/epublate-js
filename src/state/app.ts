/**
 * Top-level app store.
 *
 * Holds **process-global** state that's read on every screen:
 *   - the current theme (and the apply-to-DOM side effect)
 *   - the current LLM config (read from the library DB on boot)
 *   - whether we're in `?mock=1` demo mode
 *
 * Per-project state lives in `state/project.ts`; batch progress
 * lives in `state/batch.ts`.
 */

import { create } from "zustand";

import {
  DEFAULT_LLM_CONFIG,
  DEFAULT_UI_PREFS,
  readLlmConfig,
  readUiPrefs,
  writeLlmConfig,
  writeUiPrefs,
} from "@/db/library";
import {
  type LibraryLlmConfigRow,
  type LibraryUiPrefsRow,
  type ThemeIdT,
  THEME_ORDER,
} from "@/db/schema";
import { applyPricingOverrides } from "@/llm/pricing";

interface AppStore {
  ready: boolean;
  ui: LibraryUiPrefsRow;
  llm: LibraryLlmConfigRow;
  /** True when `?mock=1` is in the URL or `localStorage.epublate-mock-llm` is set. */
  mock_mode: boolean;
  hydrate(): Promise<void>;
  setTheme(theme: ThemeIdT): Promise<void>;
  cycleTheme(): Promise<void>;
  setUiPref<K extends Exclude<keyof LibraryUiPrefsRow, "key">>(
    key: K,
    value: LibraryUiPrefsRow[K],
  ): Promise<void>;
  setLlmConfig(
    patch: Partial<Omit<LibraryLlmConfigRow, "key">>,
  ): Promise<void>;
  setMockMode(on: boolean): void;
}

export const useAppStore = create<AppStore>()((set, get) => ({
  ready: false,
  ui: DEFAULT_UI_PREFS,
  llm: DEFAULT_LLM_CONFIG,
  mock_mode: detectInitialMockMode(),

  async hydrate() {
    const [ui, llm] = await Promise.all([readUiPrefs(), readLlmConfig()]);
    applyTheme(ui.theme);
    applyPricingOverrides(llm.pricing_overrides ?? {});
    set({ ui, llm, ready: true });
  },

  async setTheme(theme) {
    const next = await writeUiPrefs({ theme });
    applyTheme(theme);
    set({ ui: next });
  },

  async cycleTheme() {
    const cur = get().ui.theme;
    const idx = THEME_ORDER.indexOf(cur);
    const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
    await get().setTheme(next);
  },

  async setUiPref(key, value) {
    const next = await writeUiPrefs({ [key]: value } as Partial<
      Omit<LibraryUiPrefsRow, "key">
    >);
    set({ ui: next });
  },

  async setLlmConfig(patch) {
    const next = await writeLlmConfig(patch);
    if (patch.pricing_overrides !== undefined) {
      applyPricingOverrides(next.pricing_overrides ?? {});
    }
    set({ llm: next });
  },

  setMockMode(on) {
    if (on) localStorage.setItem("epublate-mock-llm", "1");
    else localStorage.removeItem("epublate-mock-llm");
    set({ mock_mode: on });
  },
}));

function detectInitialMockMode(): boolean {
  if (typeof window === "undefined") return false;
  if (localStorage.getItem("epublate-mock-llm") === "1") return true;
  const params = new URLSearchParams(window.location.search);
  return params.get("mock") === "1";
}

/**
 * Apply a theme by toggling a single `theme-*` class on the document
 * root. The CSS in `globals.css` reacts to this class.
 */
export function applyTheme(theme: ThemeIdT): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove(
    "theme-epublate",
    "theme-textual-dark",
    "theme-textual-light",
    "theme-epublate-contrast",
  );
  root.classList.add(`theme-${theme}`);
}
