# AGENTS.md

Operational rules-of-the-road for AI agents (and humans) working on
`epublatejs`. The Python `epublate` project is the source of truth; this
file translates its hard invariants into browser-port terms.

## Project mission

A browser-only ePub translation studio that:

- preserves source ePub format perfectly (round-trip identity);
- enforces glossary consistency across an entire book;
- never uploads books, prompts, or LLM responses anywhere except the
  user's configured OpenAI-compatible endpoint;
- is **resumable** — every operation is durable in IndexedDB.

## Hard invariants

1. **Format preservation.** Re-serializing a parsed XHTML chapter must be
   byte-equivalent to the input chapter. Inline tags are placeholderized
   as `[[T0]]…[[/T0]]` so the LLM never sees raw markup. The validator
   in `formats/epub/validators.ts` rejects any reassembly that doesn't
   round-trip. *Same invariant as Python `epublate.formats.epub`.*
2. **Glossary consistency.**
   - Locked terms are *hard-fail*: a translation that violates a locked
     `target_term` is rejected.
   - Target-only entries (no source term) are *soft-locked*: violations
     are flagged for the curator, not auto-rejected.
   - Aliases match on word boundaries; particle suffixes round-trip
     (`Saito-san` ↔ `Saito-さん`).
3. **Local-first & private.**
   - The app never makes any network call other than to the
     user-configured LLM endpoint. No telemetry. No analytics. No CDN
     phone-homes.
   - API keys live in IndexedDB on this device. Never committed to
     export bundles unless the user opts in.
4. **OpenAI-compatible LLMs only.** All calls go through the
   `LLMProvider` interface (`src/llm/base.ts`). Concrete providers:
   `openai_compat` (HTTP fetch with retry/backoff/`Retry-After`) and
   `mock` (deterministic, no-network). Every call is logged in
   `llm_calls`.
5. **Resumability.** Every batch operation writes durable per-segment
   state. Closing the tab is harmless: opening the project again resumes
   from `pending`/`flagged` segments.
6. **No silent data loss on schema change.** Bumping the Dexie schema
   means writing a `version(N)` upgrade with an explicit migration. We
   never wipe a user's data without their consent.

## Module layout (mirrors Python `src/epublate/`)

| Browser-port path     | Original Python module              | Purpose                              |
| --------------------- | ----------------------------------- | ------------------------------------ |
| `src/db/schema.ts`    | `epublate.db.schema`                | Table types + status enums           |
| `src/db/library.ts`   | `~/.config/epublate/{recents,ui}`   | Top-level recents + UI prefs DB      |
| `src/db/dexie.ts`     | `epublate.db.engine`                | Per-project Dexie DB                 |
| `src/db/repo/*`       | `epublate.db.repo.*`                | Repository layer                     |
| `src/formats/epub/*`  | `epublate.formats.epub`             | Loader, segmentation, reassembly     |
| `src/core/*`          | `epublate.core.*`                   | Pipeline, batch, validators, style   |
| `src/llm/*`           | `epublate.llm.*`                    | Provider, prompts, factory, pricing  |
| `src/glossary/*`      | `epublate.glossary.*`               | Matcher, enforcer, normalizer        |
| `src/lore/*`          | `epublate.lore.*`                   | Lore Book CRUD + ingest              |
| `src/workers/*`       | (none — Python ran in-process)      | Web Workers for off-main parsing     |
| `src/state/*`         | `epublate.app.state`                | Zustand stores                       |
| `src/components/*`    | `epublate.app.screens`              | UI screens & layout                  |
| `src/core/export.ts`  | `epublate.core.export` (new)        | Build translated ePub from segments  |
| `src/core/project_bundle.ts` | (no Python equivalent)        | Export/import portable project zips  |

## Testing discipline

- Unit tests next to their sources, named `*.test.ts(x)`.
- `fast-check` property-based test for round-trip identity in P1.
- `@testing-library/react` for component tests; snapshot baselines on
  the seven primary screens land in P6.
- `fake-indexeddb` is the Vitest backend for any DB-touching test.

## Style & UX commitments

- Theme system: four themes mirroring the original TUI
  (`epublate`, `textual-dark`, `textual-light`, `epublate-contrast`).
- Keyboard-first: every screen registers its hotkeys with the cheat-sheet
  store so `?` / F1 surfaces them.
- Deterministic UI: identical inputs produce identical screenshots — no
  random ordering, no time-of-day rendering quirks.

## Things you must not do

- Do **not** add a new server, proxy, or backend. The app is a static SPA.
- Do **not** add analytics, error reporters, or autoupdate channels that
  call out to a third party.
- Do **not** widen the LLM provider surface beyond OpenAI-compatible HTTP.
- Do **not** delete or re-key Dexie stores without a migration.
