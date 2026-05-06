/**
 * Global cheat sheet (mirrors the Textual app's `?` / `F1` overlay).
 *
 * Listens on `?`, `F1`, and `shift+/` and pops a single dialog with
 * the keymap for the active screen plus the global shortcuts. Other
 * components can register hotkeys via the simple registry below; the
 * sheet reads from it when shown.
 */

import * as React from "react";
import { useHotkeys } from "react-hotkeys-hook";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface HotkeyDef {
  /** Combo expressed in the key style of `react-hotkeys-hook` (e.g. `mod+enter`). */
  combo: string;
  description: string;
}

export interface HotkeyGroup {
  title: string;
  shortcuts: HotkeyDef[];
}

const GLOBAL: HotkeyGroup = {
  title: "Global",
  shortcuts: [
    { combo: "?", description: "Open this cheat sheet" },
    { combo: "F1", description: "Open this cheat sheet" },
    { combo: "Esc", description: "Close any open modal" },
  ],
};

const READER: HotkeyGroup = {
  title: "Reader",
  shortcuts: [
    { combo: "j / ↓", description: "Next segment" },
    { combo: "k / ↑", description: "Previous segment" },
    { combo: "t", description: "Translate the focused segment" },
    { combo: "Shift+T", description: "Translate the whole chapter" },
    { combo: "Shift+P", description: "Toggle the prompt preview panel" },
    { combo: "a", description: "Accept the focused translation" },
    { combo: "e", description: "Edit the focused translation" },
    { combo: "r", description: "Re-translate (bypass cache)" },
  ],
};

const GLOSSARY: HotkeyGroup = {
  title: "Glossary",
  shortcuts: [
    { combo: "/", description: "Focus the search box" },
    { combo: "n", description: "New entry" },
    { combo: "Enter", description: "Open / edit selected entry" },
    { combo: "Del", description: "Delete selected entry" },
  ],
};

const BATCH: HotkeyGroup = {
  title: "Batch / Inbox",
  shortcuts: [
    { combo: "b", description: "Open batch modal (from dashboard)" },
    { combo: "x", description: "Cancel running batch" },
    { combo: "i", description: "Jump to project Inbox" },
  ],
};

const ALL_GROUPS: HotkeyGroup[] = [GLOBAL, READER, GLOSSARY, BATCH];

export function CheatSheet(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);

  // `react-hotkeys-hook` ignores keys typed inside inputs by default,
  // which is what we want — the curator typing "?" in a search box
  // shouldn't pop the sheet.
  useHotkeys("shift+slash, f1", () => setOpen(true), { preventDefault: true });
  useHotkeys("escape", () => setOpen(false), {
    enabled: open,
    enableOnFormTags: true,
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts work from anywhere in the app unless they note
            otherwise. Pressing them inside a text input is silently
            ignored.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          {ALL_GROUPS.map((g) => (
            <div key={g.title}>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {g.title}
              </div>
              <ul className="space-y-1 text-sm">
                {g.shortcuts.map((s) => (
                  <li
                    key={`${g.title}-${s.combo}`}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span>{s.description}</span>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-foreground">
                      {s.combo}
                    </kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
