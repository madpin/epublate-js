# epublate

**A browser-only ePub translation studio with a per-project lore bible.**

Translate full-length novels with consistent terminology, tone, and style — your book, your glossary, your LLM, your device. The whole tool is a static SPA: nothing leaves the browser except the prompts you choose to send to your configured LLM endpoint.

<p align="center">
  <img src="docs/screenshots/00-hero.svg" alt="epublate dashboard showing translated chapters, attached lore book, and the active style profile" width="100%" />
</p>

> Faithful port of the [`epublate`](https://github.com/madpin/epublate) Python TUI to a fully offline web app. SQLite became IndexedDB, `lxml` became native `DOMParser`, the `openai` SDK became `fetch`, and the Textual TUI became a keyboard-first React app — but the prompts, the glossary semantics, and the segmentation invariants are byte-equivalent.

---

## Why epublate?

**It is not a "click translate" button.** Long-form fiction breaks every assumption a per-paragraph translator makes:

- Characters get renamed mid-chapter when the LLM forgets it called Mr. Bennet "Бенне́т" three pages ago.
- Tone wanders from Victorian-formal to mall-casual whenever a chapter break flushes the context.
- Footnotes, anchors, and `<page-list>` markers vanish, and your ePub fails `epubcheck`.
- Costs explode because every retry re-translates everything from scratch.

epublate fixes all four:

- **Glossary as a hard contract.** Locked terms enforce one-and-only-one target spelling. The translator's prompt embeds the matching entries; the post-processor *fails the segment* if the LLM ignored them. The Inbox surfaces the violations for one-click cascade re-translation.
- **Style as a first-class object.** Pick from ten verbatim presets (literary fiction, hard sci-fi, romance, military thriller, …) or write your own. The helper LLM can sniff a chapter and suggest one. The chosen style is part of the cache key, so changing it invalidates exactly what it should.
- **Byte-faithful ePub round-trip.** We capture the source DOCTYPE verbatim, treat `<table>` / `<ul>` / `<figure>` as block-level scaffolding, preserve empty `<a id="page_v"/>` anchors, and pass non-chapter assets (CSS, fonts, SVGs) through as raw bytes. The output passes `epubcheck` against EPUB 2 and EPUB 3.
- **Cost-aware batches.** Configurable concurrency, hard budget caps, full LLM audit log, SHA-256-keyed cache that survives across batches, and a "translate chapter" affordance from the Reader for incremental cost.

---

## Highlights

- **Sectioned navigation.** Library (Projects, Lore Books) is always visible; the Project section appears when a book is open and groups Dashboard, Reader, Glossary, Inbox, Project Settings, and the advanced views (LLM activity, Intake runs, Logs).
- **Reader with side-by-side panes**, scroll-sync that's anchored to segments rather than pixels (because translated text is rarely the same length), keyboard-first hotkeys, and per-project position memory — leave the Reader and come back to the same chapter, the same segment, the same scroll offset.
- **Glossary** with proposed / approved / locked statuses, alias support on both source and target sides, target-only entries (for invented terms), JSON / CSV import-export, and an Inbox flow for cascade re-translation when a locked term changes.
- **Lore Books**: standalone, attachable per-project lore artifacts. Ingest from a translated reference ePub, ingest from a source ePub via helper LLM, or import from another project. Attach with read-only or writable mode and a per-attachment priority.
- **Batch runner** with bounded concurrency, hard budget cap, AbortController-based cancel, persistent status bar that survives navigation, helper-LLM pre-pass per chapter (optional), and per-segment failure isolation.
- **Per-project context window.** Inject up to N preceding segments of the current chapter into the translator prompt as read-only context, with a separate character budget for paragraph-heavy chapters.
- **Project bundles** — one-click `.zip` export with the original ePub plus every Dexie row as JSON-Lines, re-importable on any device with a fresh project id (so the same bundle can be imported multiple times without colliding).
- **PWA-ready**: `vite-plugin-pwa` is wired; the app is installable and works offline (after the first load, cached LLM responses notwithstanding).
- **Mock mode** (`?mock=1`) for demos and screenshots — every call goes through a deterministic provider and the cache so the UI is fully exercised without network access or API keys.
- **Themes** — four built-in themes (Slate, Solarized, Midnight, Ledger), pickable from the sidebar footer.

---

## 60-second tour

```bash
git clone …/epublatejs && cd epublatejs
npm install
npm run dev                  # http://localhost:5173
```

Then:

1. Visit **Settings → LLM**, paste an OpenAI-compatible base URL + key, hit "Test connection". (Or skip this and append `?mock=1` to the URL for the deterministic mock provider.)
2. From the **Projects** landing page, drop an ePub onto the dropzone or click "New project". Pick source / target language and a style preset.
3. The **Dashboard** opens. Click "Translate batch" to run the helper-LLM pre-pass, then translate every pending segment with bounded concurrency and a budget cap. Or open the **Reader**, focus a segment, and press `t` to translate just that one.
4. **Glossary** picks up proposed entries from the helper LLM and from the translator's `new_entities` field on every successful call. Approve or lock the ones you care about.
5. When you're happy, click **Download ePub** on the Dashboard for a translated file, or **Download bundle** for the full project archive.

For a deeper walk-through with screenshots and concept diagrams, see [**docs/USAGE.md**](docs/USAGE.md).

---

## Privacy & data location

| What                                       | Where it lives                                                       |
| ------------------------------------------ | -------------------------------------------------------------------- |
| Source ePub bytes                          | `epublate-project-<id>` IndexedDB on this device                     |
| Segments, glossary, events, LLM audit log  | Same per-project DB                                                  |
| Reader scroll position                     | `localStorage` (per project)                                         |
| Library projection (recents, theme, prefs) | `epublate-library` IndexedDB                                         |
| LLM API key                                | `epublate-library` IndexedDB. Redact / clear from the Settings screen |
| Lore Books                                 | One IndexedDB per Lore Book, `epublate-lore-<id>`                    |
| **What never leaves your browser**         | The book, your projects, your glossary, your audit log               |
| **What is sent to your LLM endpoint**      | Only the prompts you trigger (segment translate, helper extract)     |

`navigator.storage.persist()` is requested on first project create so the OS doesn't evict your work under storage pressure.

The Settings screen lets you wipe the entire library DB and every per-project DB in one click ("Reset all data").

---

## Quick reference

| Command              | What it does                                       |
| -------------------- | -------------------------------------------------- |
| `npm run dev`        | Vite dev server                                    |
| `npm run build`      | `tsc -b && vite build` — production bundle         |
| `npm run preview`    | Serve the production bundle locally                |
| `npm run test`       | Vitest, includes `fake-indexeddb` and DOM tests    |
| `npm run typecheck`  | `tsc -b --noEmit` only                             |
| `npm run lint`       | ESLint                                             |

| Hotkey      | Action                                                          |
| ----------- | --------------------------------------------------------------- |
| `?` or `F1` | Open the cheat sheet                                            |
| `Esc`       | Close any open modal                                            |
| `j` / `↓`   | Next segment (Reader)                                           |
| `k` / `↑`   | Previous segment (Reader)                                       |
| `t`         | Translate the focused segment                                   |
| `Shift+T`   | Translate the entire current chapter (Reader)                   |
| `r`         | Re-translate the focused segment, bypassing the cache           |
| `a`         | Accept the focused translation                                  |
| `e`         | Edit the focused translation                                    |
| `/`         | Focus the Glossary search box                                   |
| `n`         | New Glossary entry                                              |
| `b`         | Open the Batch modal (Dashboard)                                |
| `x`         | Cancel the running batch                                        |
| `i`         | Jump to the project Inbox                                       |

---

## Browser realities

- **CORS** — works against OpenAI, OpenRouter, Together, Groq, DeepInfra, and any other OpenAI-compatible service. Local **Ollama** requires `OLLAMA_ORIGINS=*` so the browser is allowed to call it.
- **API keys** are stored in IndexedDB on this device only. They are never logged outside the LLM audit row, which itself stays local. The Settings screen has redact / clear actions.
- **Storage** — a 100,000-word novel is roughly 1–5 MB of segments + a few MB of LLM audit. The Settings screen surfaces per-project size and a delete action.
- **No filesystem** — ePubs come in via the dropzone or file picker; exports go out as browser downloads. There is no file watcher and no syncing — the Bundle export is your portable representation.
- **`epubcheck`** — the bundled writer validates structurally on round-trip (BOMs, DOCTYPEs, namespaces, internal `data-*` attributes, byte-faithful pass-through for non-chapter assets). For external validation, run `epubcheck` against the downloaded `.epub`.

---

## Architecture (one diagram)

<p align="center">
  <img src="docs/diagrams/architecture.svg" alt="epublate architecture: UI → Zustand → core/pipeline → llm provider; UI → Dexie repo → per-project IndexedDB" width="100%" />
</p>

```
src/
├── core/             pipeline, batch, extractor (helper LLM), style, project bundles, exports
├── db/               Dexie schemas + repo layer (projects, segments, glossary, lore, library)
├── formats/epub/     loader, segmentation, writer; round-trip identity is the invariant
├── glossary/         matcher, enforcer, IO
├── llm/              base, openai_compat, mock, factory, prompts (translator, extractor, …)
├── lore/             lore book model + per-project attachment management
├── routes/           one .tsx per screen; AppShell composes the sidebar + outlet
├── components/       shadcn-style primitives (forms, dialogs, layout)
└── state/            Zustand stores (app, ui, batch)
```

Per-project data lives in a **named Dexie database** (one per project), so deleting a project is a single `Dexie.delete(name)` and the IDB inspector shows one DB per project — directly mirroring the Python tool's one-`.epublate`-per-project SQLite layout. Lore Books follow the same pattern.

---

## Project bundles

The Dashboard's **Download bundle** button produces `<name>.epublate-project.zip` with the original ePub plus every Dexie row as JSON-Lines. The Projects landing page has a matching **Import bundle** button that re-hydrates a previously-exported project into a fresh database with a new id, so the same bundle can be imported multiple times without colliding.

```
<name>.epublate-project.zip
├── manifest.json          schema version, exported_at, project id
├── project.json           single project row
├── library_row.json       library-level metadata (size, progress, …)
├── original.epub          verbatim source bytes
├── chapters.jsonl         one JSON object per line
├── segments.jsonl
├── glossary.jsonl + glossary_aliases.jsonl + glossary_revisions.jsonl
├── entity_mentions.jsonl
├── llm_calls.jsonl        full LLM audit log (request + response)
├── events.jsonl           append-only event stream
├── intake_runs.jsonl + intake_run_entries.jsonl
└── attached_lore.jsonl + lore_meta.jsonl + lore_sources.jsonl
```

Bundles are forward-compatible: older clients refuse newer schemas with a clear error instead of silently corrupting state.

---

## Tech stack

| Layer            | Choice                                                                                |
| ---------------- | ------------------------------------------------------------------------------------- |
| Build            | [Vite 6](https://vitejs.dev) + [TypeScript 5.7](https://www.typescriptlang.org/)      |
| UI               | [React 19](https://react.dev) + [React Router 7](https://reactrouter.com/)            |
| Styling          | [Tailwind CSS 4](https://tailwindcss.com/) + shadcn-style primitives + [Radix](https://www.radix-ui.com/) |
| Icons            | [lucide-react](https://lucide.dev/)                                                   |
| Storage          | [Dexie 4](https://dexie.org/) (IndexedDB)                                             |
| State            | [Zustand 5](https://github.com/pmndrs/zustand)                                        |
| ePub             | [JSZip](https://stuk.github.io/jszip/) + native `DOMParser` / `XMLSerializer`         |
| Tokens / costs   | [`gpt-tokenizer`](https://www.npmjs.com/package/gpt-tokenizer)                        |
| Tests            | [Vitest](https://vitest.dev) + [`fake-indexeddb`](https://www.npmjs.com/package/fake-indexeddb) + [`@testing-library/react`](https://testing-library.com/) + [`fast-check`](https://github.com/dubzzz/fast-check) |
| PWA              | [`vite-plugin-pwa`](https://vite-pwa-org.netlify.app/)                                |
| Toasts           | [`sonner`](https://sonner.emilkowal.ski/)                                             |
| Hotkeys          | [`react-hotkeys-hook`](https://github.com/JohannesKlauss/react-hotkeys-hook)          |

---

## Contributing

- Tests run on `vitest`; new behaviour wants a regression test next to the source (e.g. `src/core/pipeline.test.ts`). DB-touching tests use `fake-indexeddb`; round-trip ePub tests use `JSDOM`.
- Architectural conventions and invariants live in [`AGENTS.md`](AGENTS.md). Read it before changing the segmentation pipeline or the cache key shape — both have hidden contracts the tests depend on.
- The plan that scaffolded this port is at `~/.cursor/plans/epublate browser port-*.plan.md` (out of repo). Phase notes are preserved in commit history.

---

## License

To be decided per project. The original Python tool's license applies to the prompts and the segmentation invariants we ported verbatim.
