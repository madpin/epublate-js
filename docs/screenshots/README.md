# Screenshots

The `README.md` and `docs/USAGE.md` reference screenshots living in this folder. Each one captures a specific app state on a specific screen at a specific viewport.

The repo ships **placeholder SVGs** (one per screen, named `<slug>.svg`) so the docs render gracefully before the real images exist. To upgrade to real screenshots:

1. Capture each PNG with the corresponding **base name** from the table below (e.g. `04-reader.png`).
2. Drop the PNG into this folder alongside the placeholder SVG.
3. Either delete the matching `.svg` and rename references in the docs, or leave the SVG as a fallback and search-replace `screenshots/<slug>.svg` → `screenshots/<slug>.png` in `docs/USAGE.md`. The README references `00-hero.svg` and `docs/diagrams/*.svg`, which stay as illustrations.

> Filenames are the contract — keep them stable across captures so the docs don't break.

## How to capture

The cleanest, most reproducible way is **mock mode** (`?mock=1`) so the LLM output is deterministic and the cost meter shows real numbers without hitting a real endpoint:

```bash
npm run dev
# Visit http://localhost:5173/?mock=1
```

Then walk through the captures below in order, since each one builds on the previous app state.

Recommended capture settings:

- **Viewport**: `1440 × 900` (16:10) — matches the README hero ratio.
- **Format**: PNG, no compression beyond the default. SVG is fine for diagrams; PNG is preferred for live screenshots so anti-aliased text reads well in dark themes.
- **Theme**: Slate (default) for neutral colour, Midnight for the dark-mode showcase.
- **Hide your real API key.** Use the redact toggle in Settings → LLM, or capture in mock mode where the key field is empty.
- **Filename**: lower-kebab-case, two-digit numeric prefix matching the order in the docs (e.g. `04-reader.png`).

If you have Playwright lying around, the `tools/snap.ts` template at the bottom of this file is a starting point for an automated screenshot rig — it loads `?mock=1`, seeds a project, and walks every state.

## Capture list

| # | Filename                              | Screen              | State to capture                                                                                  |
| - | ------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------- |
|   | `00-hero.png`                         | Dashboard           | Featured Dashboard with progress card, attached lore, and chapter list — the "front-page" shot.   |
| 1 | `01-projects-empty.png`               | Projects (empty)    | Empty Projects screen with the dropzone visible; no projects exist yet.                           |
| 2 | `01b-projects-populated.png`          | Projects (populated)| Projects screen with 4–6 projects, each showing progress and last-opened time.                    |
| 3 | `02-new-project-modal.png`            | New project modal   | Modal open with an ePub picked, source/target language set, "Literary fiction" preset selected.   |
| 4 | `03-dashboard.png`                    | Dashboard           | Mid-translation project: progress, helper-suggestion callout, attached lore, scrollable chapters. |
| 5 | `04-reader.png`                       | Reader              | Three-column Reader on chapter 4, segment 12 focused, target pane showing translated text.       |
| 6 | `05a-reader-translate-chapter.png`    | Reader header       | "Translate chapter" button visible with a count badge of remaining pending segments.              |
| 7 | `05b-translate-chapter-modal.png`     | Batch modal         | Batch modal opened from Reader, scope locked to current chapter, default values populated.        |
| 8 | `05c-batch-modal-dashboard.png`       | Batch modal         | Batch modal opened from Dashboard with full project scope, budget cap visible.                    |
| 9 | `06-glossary.png`                     | Glossary            | 100+ entries; mix of proposed / approved / locked statuses, search box highlighted.               |
| 10| `07-glossary-edit.png`                | Glossary edit modal | Editing a locked character entry with multiple aliases on both source and target sides.           |
| 11| `08-inbox.png`                        | Inbox               | Mixed inbox with glossary violations, placeholder mismatches, and a cascade banner.               |
| 12| `09-project-settings.png`             | Project Settings    | Five cards visible (Identity, Style, Context window, Budget, LLM overrides). Save button enabled. |
| 13| `10-lore-books.png`                   | Lore Books          | Lore Books library with 3 books, entry counts, source/target languages, and Open buttons.        |
| 14| `11-lore-book-dashboard.png`          | Lore Book dashboard | Per-Lore-Book dashboard with entry counts, source ePub list, ingest history.                     |
| 15| `12-settings-llm.png`                 | Settings → LLM      | LLM tab with base URL + (redacted) key, model picker, and a green "Connection OK" pill.           |
| 16| `13-intake-runs.png`                  | Intake runs         | List of intake runs; latest one with the "Apply suggested style" CTA.                            |
| 17| `14-llm-activity.png`                 | LLM activity        | Cost meter, token totals, and a table of recent calls with cache hits highlighted.               |
| 18| `15-cheat-sheet.png`                  | Cheat sheet         | Keyboard shortcuts dialog open, all four groups visible.                                          |
| 19| `16-themes.png`                       | Theme picker        | Theme dropdown open in the sidebar footer with all four themes listed and the current one ticked. |
| 20| `17-pwa-install.png`                  | PWA install prompt  | Browser install prompt for the PWA (Chromium / Edge address bar).                                 |

## Mock mode tips

- The mock provider fills the cache deterministically, so re-running a batch in mock mode after you've translated a project shows realistic cache-rate numbers.
- The seeded project for screenshots is meant to be one of the public-domain ePubs in your library (Project Gutenberg's Pride & Prejudice or Frankenstein work great — they're already exercised by the test suite).
- If a screenshot needs a "before" state (empty Inbox, empty Glossary), open a fresh project first.

## Optional: Playwright snap script

The `tools/snap.ts` script (not yet committed) is a one-shot Playwright rig that:

1. Boots the dev server in mock mode.
2. Imports a seeded project bundle.
3. Walks every screen in order, taking a screenshot at each step.
4. Writes the PNGs into this folder.

```ts
// tools/snap.ts (sketch)
import { chromium } from "playwright";

const seed = "tests/fixtures/seeded-project.epublate-project.zip";

const URL = "http://localhost:5173/?mock=1";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  await page.goto(URL);
  await page.click('text="Import bundle"');
  await page.setInputFiles('input[type="file"]', seed);
  await page.waitForSelector('text="Pride & Prejudice"');
  await page.screenshot({ path: "docs/screenshots/01b-projects-populated.png" });
  // … repeat for each capture
  await browser.close();
})();
```

Bring in `playwright` as a dev dependency (`npm i -D playwright`), commit `tools/snap.ts`, and run `npx tsx tools/snap.ts`.
