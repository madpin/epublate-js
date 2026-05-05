import * as React from "react";
import { Palette } from "lucide-react";

import { useAppStore } from "@/state/app";
import { THEME_LABELS, THEME_ORDER, type ThemeIdT } from "@/db/schema";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Compact theme picker.
 *
 * Scope:
 *   - Click to pop up the menu and pick any theme.
 *   - We deliberately do NOT register a global keyboard hotkey for
 *     theme cycling: a single-letter combo (e.g. `t`) collides with
 *     the Reader's translate hotkey, and busier combos like
 *     `Cmd+Shift+T` are claimed by browsers for "reopen closed tab".
 *     Dropdown-only keeps the hotkey table clean for the workflow
 *     that matters (translation).
 */
export function ThemeToggle(): React.JSX.Element {
  const ui_theme = useAppStore((s) => s.ui.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
          <Palette className="size-3.5" />
          <span className="capitalize">{THEME_LABELS[ui_theme]}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {THEME_ORDER.map((t: ThemeIdT) => (
          <DropdownMenuItem
            key={t}
            onSelect={() => void setTheme(t)}
            className={t === ui_theme ? "bg-accent/60" : undefined}
          >
            {THEME_LABELS[t]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
