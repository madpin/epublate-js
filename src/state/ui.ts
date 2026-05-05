/**
 * Cross-screen UI state.
 *
 * Anything the keyboard cheat-sheet needs to introspect (active screen,
 * registered hotkeys), plus the modal stack so dialogs aren't tied to
 * a specific route.
 */

import { create } from "zustand";

export interface RegisteredHotkey {
  id: string;
  keys: string;
  label: string;
  group?: string;
}

interface UiStore {
  active_screen: string;
  hotkeys: RegisteredHotkey[];
  cheat_sheet_open: boolean;
  setActiveScreen(name: string): void;
  registerHotkeys(group: string, items: Omit<RegisteredHotkey, "group">[]): void;
  clearHotkeys(group: string): void;
  toggleCheatSheet(): void;
  setCheatSheetOpen(open: boolean): void;
}

export const useUiStore = create<UiStore>()((set) => ({
  active_screen: "projects",
  hotkeys: [],
  cheat_sheet_open: false,

  setActiveScreen(name) {
    set({ active_screen: name });
  },

  registerHotkeys(group, items) {
    set((state) => {
      const without = state.hotkeys.filter((h) => h.group !== group);
      const with_group = items.map((it) => ({ ...it, group }));
      return { hotkeys: [...without, ...with_group] };
    });
  },

  clearHotkeys(group) {
    set((state) => ({
      hotkeys: state.hotkeys.filter((h) => h.group !== group),
    }));
  },

  toggleCheatSheet() {
    set((state) => ({ cheat_sheet_open: !state.cheat_sheet_open }));
  },

  setCheatSheetOpen(open) {
    set({ cheat_sheet_open: open });
  },
}));
