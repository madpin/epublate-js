# AGENTS.md

Operational rules-of-the-road for AI agents (and humans) working on
`epublatejs`. The Python `epublate` project is the source of truth; this
file translates its hard invariants into browser-port terms.

> **See also.** The narrative companion to this terse doc is
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — modules, data flow,
> sequence diagrams, and the cache-key recipe explained at length. For
> the curator-side tour of every screen, read
> [`docs/USAGE.md`](docs/USAGE.md). The README front page links to both.

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
     user-configured LLM endpoint, the user-configured embedding
     endpoint, and — *only after the curator's explicit per-project
     consent* — the one-time download of a `Xenova/*` embedding model
     from `huggingface.co`. No telemetry. No analytics. No CDN
     phone-homes.
   - API keys live in IndexedDB on this device. Never committed to
     export bundles unless the user opts in.
4. **OpenAI-compatible LLMs only.** All calls go through the
   `LLMProvider` interface (`src/llm/base.ts`). Concrete providers:
   `openai_compat` (HTTP fetch with retry/backoff/`Retry-After`) and
   `mock` (deterministic, no-network). Every call is logged in
   `llm_calls`. The sibling `EmbeddingProvider` interface
   (`src/llm/embeddings/base.ts`) covers the optional retrieval
   layer with the same audit-ledger contract — embedding calls
   write `purpose="embedding"` rows.
   - **`.env` is first-run bootstrap only.** Build-time
     `VITE_EPUBLATE_LLM_*` defaults seed an *empty* Dexie LLM row
     on first hydrate via `seedLlmConfigIfEmpty` (see
     `src/lib/env_defaults.ts` + `src/state/app.ts`). Curator-saved
     rows always win — env values never silently overwrite or
     re-seed an existing config. The `VITE_EPUBLATE_LLM_API_KEY`
     variable is convenient for local dev / single-user deploys but
     is baked into the JS bundle; the `.env.example` file is the
     canonical place this warning lives.
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
| `src/lib/lru.ts`      | (no Python equivalent)              | Generic LRU cache utility            |
| `src/lib/throttle.ts` | (no Python equivalent)              | Cooperative async throttle (adaptive concurrency) |
| `src/lib/env_defaults.ts` | (no Python equivalent)          | Build-time `.env` LLM defaults + Settings presets |
| `src/workers/*`       | (none — Python ran in-process)      | Web Workers for off-main parsing & ZIP I/O |
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
- `tools/bench.ts` (run via `npm run bench`) is the synthetic
  end-to-end benchmark over `docs/petitprince.epub`. It runs against
  the deterministic `MockProvider` and prints wall-clock + matcher /
  entity-cache counters. CI should treat numbers as ratios against a
  rolling baseline, not absolute thresholds.

## Performance & scale playbook

A handful of always-on optimisations live under the worker /
utility boundary so they're invisible to callers:

- **Glossary matcher regex cache.** `src/glossary/matcher.ts` caches
  compiled `RegExp` instances in a module-scoped `Lru` keyed by the
  joined-and-cleaned term list. Two passes over an unchanged
  glossary compile every pattern exactly once.
- **Pre-parse entity-expansion cache.** `src/formats/epub/entities.ts`
  memoises XHTML entity rewrites for identical input strings so
  chapter reloads pay the scan cost at most once.
- **ZIP I/O off the main thread.** `src/workers/epub.worker.ts` runs
  JSZip decompression and re-compression in a Web Worker, with a
  transparent inline fallback for environments without `Worker`
  support (jsdom, niche browsers). `loader.ts` and `writer.ts` go
  through `src/workers/epub.client.ts`. DOM parsing stays on the
  main thread because `DOMParser` / `XMLSerializer` aren't reliably
  available in workers.
- **Adaptive batch concurrency.** `src/core/batch.ts` reads
  `provider.getRateLimitHint()` after every successful call and
  attenuates a shared `Throttle` so the effective in-flight count
  never exceeds half of `x-ratelimit-remaining-requests`, floored
  at 1 and capped at the curator's configured concurrency. Each
  transition writes a `batch.concurrency_adjusted` audit event. The
  policy degrades cleanly to a no-op for providers that don't
  expose rate-limit headers (mock, raw Ollama, llama.cpp).

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
  - **Exception (embeddings).** The `EmbeddingProvider`'s `local`
    backend may download model weights from `huggingface.co/Xenova/*`
    *after the curator clicks through the consent dialog at least
    once per project*. The download URL must come from
    `@xenova/transformers`'s built-in resolver — never hard-code a
    `huggingface.co` URL elsewhere in the codebase.
- Do **not** delete or re-key Dexie stores without a migration.

## Cursor rules

The `.cursor/rules/` folder restates these invariants in machine-
readable form for AI coding tools:

- `always-core.mdc` – core project invariants (always applied).
- `no-network-side-effects.mdc` – prohibits third-party network calls
  (always applied).
- `docs-and-screenshots.mdc` – keep `README.md`, `docs/ARCHITECTURE.md`,
  `docs/USAGE.md`, and `tools/snap.mjs` screenshots in sync when a
  screen, module, or schema changes (always applied).
- `code-style.mdc` – TypeScript / React style for `src/`.
- `testing.mdc` – Vitest + fake-indexeddb + fast-check conventions.
- `db-dexie.mdc` – Dexie schema, repos, and migration rules.
- `epub-format.mdc` – round-trip and placeholder invariants.
- `llm-provider.mdc` – `LLMProvider` interface and cache rules.
- `ui-shadcn.mdc` – shadcn/ui + Tailwind + accessibility conventions.
- `state-zustand.mdc` – store conventions for `src/state/`.

When the human-readable AGENTS.md changes, mirror the change into the
relevant `.cursor/rules/` file.
