/**
 * Snapshot test for the cheat-sheet keymap dialog.
 *
 * The dialog itself only opens via `?` / `F1`; testing the open
 * pathway requires a `userEvent` keystroke. We assert the rendered
 * markup once it's open so the keymap stays stable across refactors.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { CheatSheet } from "./CheatSheet";

describe("CheatSheet", () => {
  it("opens on ?, shows global shortcuts, and matches snapshot", async () => {
    render(<CheatSheet />);

    // The body of the cheat sheet is portaled, so we need to fire on
    // the document — react-hotkeys-hook listens at the window level.
    fireEvent.keyDown(document.body, {
      key: "?",
      code: "Slash",
      shiftKey: true,
    });

    const heading = await screen.findByText("Keyboard shortcuts");
    expect(heading).toBeInTheDocument();
    // Two rows describe the same shortcut (mapped to `?` and F1).
    expect(screen.getAllByText("Open this cheat sheet")).toHaveLength(2);
    expect(screen.getByText("Reader")).toBeInTheDocument();
    expect(screen.getByText("Glossary")).toBeInTheDocument();
    expect(screen.getByText("Batch / Inbox")).toBeInTheDocument();

    // Stability snapshot of the keymap text content. We avoid
    // snapshotting Radix's portal markup (which changes between
    // versions) and just snapshot the visible text.
    const grid_text = Array.from(
      document
        .querySelector("[role='dialog']")
        ?.querySelectorAll("li") ?? [],
    )
      .map((li) => li.textContent?.trim() ?? "")
      .join("\n");
    expect(grid_text).toMatchInlineSnapshot(`
      "Open this cheat sheet?
      Open this cheat sheetF1
      Close any open modalEsc
      Next segmentj / ↓
      Previous segmentk / ↑
      Translate the focused segmentt
      Translate the whole chapterShift+T
      Accept the focused translationa
      Edit the focused translatione
      Re-translate (bypass cache)r
      Focus the search box/
      New entryn
      Open / edit selected entryEnter
      Delete selected entryDel
      Open batch modal (from dashboard)b
      Cancel running batchx
      Jump to project Inboxi"
    `);
  });
});
