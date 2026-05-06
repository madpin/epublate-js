# Screenshots

The `README.md` and `docs/USAGE.md` reference screenshots living in this folder. Each one captures a specific app state on a specific screen at a specific viewport.

The shipped images are real PNGs captured against a dev server running in `?mock=1` mode, so the LLM responses are deterministic and the cost meter renders predictable numbers. The capture is fully automated by **`tools/snap.mjs`** at the repo root.

## Refresh the screenshots

```bash
npm run dev                            # one terminal: serves http://localhost:5173
node tools/snap.mjs                    # another terminal: walks every screen
```

The script:

1. Resets every IndexedDB DB the SPA owns (clean slate every run).
2. Creates a project from `tests/fixtures/petitprince.epub` via the New Project modal, with `auto_intake = true` and `tone_sniff = false` for deterministic helper-LLM behaviour.
3. Walks the project-level screens by SPA navigation (preserving Dexie context across hops):
   - Projects empty → New Project modal → Dashboard → Translate batch → Dashboard (translated) → Reader (Chapitre III, prose-rich) → Glossary → Inbox → Project Settings (default + **Relevant context mode**) → Lore Books → Settings → LLM (default + **Embeddings card** + **Install card**) → Intake runs → LLM activity → Cheat sheet → Theme picker → **Help & guides (hero + Local Ollama section)** → Projects populated → Hero (Dashboard).
4. Saves PNGs into this folder using the contract filenames listed below.

When only the Help & guides route changed, you can skip the full sweep and run `node tools/snap-help.mjs` instead — it defaults to `:5174` (the port Vite picks when `:5173` is in use); point it elsewhere with `BASE_URL=http://localhost:5173`.

The capture runs at viewport `1024 × 640` against the default `epublate` theme. To re-capture in a different theme, set `THEME` in the script (`epublate`, `textual-dark`, `textual-light`, `epublate-contrast`).

> Filenames are the doc contract — keep them stable across captures so the docs don't break.

## Capture list

| #  | Filename                              | Screen              | What it shows                                                                                     |
| -- | ------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------- |
|    | `00-hero.png`                         | Dashboard (hero)    | Dashboard right after a successful batch run — the README front-page shot.                        |
| 1  | `01-projects-empty.png`               | Projects (empty)    | Empty Projects screen with the dropzone visible.                                                  |
| 2  | `01b-projects-populated.png`          | Projects (populated)| Projects list with the seeded "Le Petit Prince" project.                                          |
| 3  | `02-new-project-modal.png`            | New project modal   | Modal open with `petitprince.epub` loaded, `fr → en`, Literary fiction preset.                    |
| 4  | `03-dashboard.png`                    | Dashboard (pre)     | Dashboard at 0/772 — pre-translation state.                                                       |
| 5  | `03-dashboard-translated.png`         | Dashboard (post)    | Dashboard at 772/772 with cache hits, lifetime spend, and chapter list — same shape as the hero.  |
| 6  | `04-reader.png`                       | Reader              | Three-column Reader on Chapitre III with prose source + target panes.                             |
| 7  | `05a-reader-translate-chapter.png`    | Reader header       | Reader with the "Translate chapter" button highlighted.                                           |
| 8  | `05c-batch-modal-dashboard.png`       | Batch modal         | Translate-batch modal opened from the Dashboard, scope = whole project.                           |
|    | `05d-reader-prompt-preview.png`       | Reader (Shift+P)    | Slide-in **Prompt preview** panel anchored to the focused segment with the System / User / Wire tabs. |
| 9  | `06-glossary.png`                     | Glossary            | Glossary screen (mock mode populates few proposed entries; the layout is the focus).              |
| 10 | `08-inbox.png`                        | Inbox               | Inbox empty-state structure: flagged segments / proposed entries / recent alerts cards.           |
| 11 | `09-project-settings.png`             | Project Settings    | Identity, Style, Context-window, Budget, LLM-overrides cards.                                     |
|    | `09b-relevant-context-mode.png`       | Project Settings    | Context-window card with the **Relevant** mode selected and the cosine-similarity sub-controls visible. |
|    | `09c-prompt-options.png`              | Project Settings    | **Prompt options** card with the system-block + user-block checkbox grid that controls what each translation prompt carries. |
|    | `09d-book-summary.png`                | Project Settings    | **Book summary** card — empty state with the "Generate from book" CTA, draft textarea, and live token count. |
|    | `09e-chapter-summaries.png`           | Project Settings    | **Chapter summaries** card listing chapters with per-row generate / clear actions and the bulk "Generate missing" / "Regenerate all" controls. |
|    | `09f-prompt-simulator.png`            | Project Settings    | **Prompt simulator** card showing the byte-equivalent translator prompt for the project's first non-empty segment, with what-if toggles and the system / user / wire-payload tabs. |
| 12 | `10-lore-books.png`                   | Lore Books          | Empty Lore Books library with the New Lore Book + Import bundle CTAs.                             |
| 13 | `12-settings-llm.png`                 | Settings → LLM      | LLM endpoint card with base URL + key + translator/helper model fields, plus Defaults and Pricing.|
|    | `12c-ollama-options-card.png`         | Settings → Ollama options | Ollama-specific knobs (`num_ctx`, `num_predict`, sampling, Mirostat, **Disable thinking**) revealed via "Show anyway" because the mock base URL is OpenAI. Shows the four common-tier inputs + preset chips. |
|    | `12b-embeddings-card.png`             | Settings → Embeddings| Embeddings card scrolled into view — provider picker (none / openai-compat / local), model, dim, batch size, and consent state. |
|    | `12d-batch-reliability-card.png`      | Settings → Batch reliability | Per-segment retry budget + sliding-window circuit breaker (`Max retries per segment`, `Recent-segment window`, `Failures before pause`) with the Restore-defaults button. |
| 14 | `13-intake-runs.png`                  | Intake runs         | List of helper-LLM intake runs for the seeded project.                                            |
| 15 | `14-llm-activity.png`                 | LLM activity        | Per-call audit ledger: 100 calls, cost, prompt/completion tokens, recent-call list.               |
| 16 | `15-cheat-sheet.png`                  | Cheat sheet         | Keyboard-shortcut dialog (`?` / `F1`).                                                            |
| 17 | `16-themes.png`                       | Theme picker        | Sidebar-footer theme dropdown open with all four themes listed.                                   |
| 18 | `17-install-pwa.png`                  | Settings → Install  | Install card scrolled into view: install-state pill, "App cached for offline use" pill, online/offline pill, and the **Install epublate** button. Headless Chromium doesn't fire `beforeinstallprompt`, so the deterministic state is "Browser-managed install" with the explanatory hint visible. |
| 19 | `18-help.png`                         | Help & guides       | Top of the in-app Help & guides route — hero strip, fact pills, CTA buttons, ToC, and the start of the Quickstart card grid. |
|    | `18b-help-ollama.png`                 | Help & guides → Local Ollama | The Help page scrolled to the **Connect a local LLM (Ollama)** section: install command + the multi-scheme `OLLAMA_ORIGINS` recipe that ships in the on-screen tutorial. |

The capture script does *not* exercise the per-chapter Translate Chapter modal (`05b`) or the Lore Book dashboard (`11`) yet; both are described in prose in `docs/USAGE.md` until we wire them up.

## Mock mode tips

- The mock provider fills the cache deterministically, so re-running a batch shows realistic cache-rate numbers.
- The seeded project (`tests/fixtures/petitprince.epub`) is one of the public-domain ePubs already exercised by the test suite; swapping in a longer book is fine if you want a meatier hero shot.
- If a screenshot needs a "before" state (empty Inbox, empty Glossary), let `snap.mjs` reset Dexie at the start — every run starts from a wiped library.
