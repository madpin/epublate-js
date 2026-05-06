/**
 * Reader screen — interactive translation workspace (mirrors
 * `epublate.app.screens.reader`).
 *
 * Three-column layout:
 *
 * 1. **Chapter sidebar.** Spine-order list of every parsed chapter.
 *    Click to switch; the URL keeps the current chapter so reload /
 *    back-navigation keeps the curator's place.
 * 2. **Source pane.** Stacked segment cards; the focused card has a
 *    coloured left border. The placeholder-bearing source text is
 *    rendered via `renderPreview` so curators see real `<em>` /
 *    `<strong>` instead of `[[T0]]…[[/T0]]`.
 * 3. **Target pane.** Mirror of the source pane showing the current
 *    target text or "(not yet translated)". Translate / retry write
 *    here through `translateSegment`.
 *
 * Scroll-sync mirrors the Python version's segment-anchored algorithm:
 * we pick the topmost source card whose box contains the source pane's
 * scrollTop, compute the fractional offset within that card, then
 * scroll the target pane to the same fractional offset on its matching
 * card. Per-card heights differ (source vs translated text aren't the
 * same length), so a pixel-only mirror would drift; segment anchoring
 * keeps the panes aligned at the segment level. The two extremes (top
 * and bottom) snap to absolute 0 / `scrollHeight - clientHeight`
 * because the card-anchor loop can't bind to anything when the
 * scrollTop sits in the leading or trailing padding of the pane.
 *
 * The Reader is read-mostly: writes go through the existing
 * `translateSegment` pipeline, and `useLiveQuery` re-reads the segment
 * rows after every commit so the UI updates without manual plumbing.
 */

import * as React from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  Check,
  Layers,
  Pencil,
  Play,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";

import { BatchModal } from "@/components/forms/BatchModal";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { libraryDb } from "@/db/library";
import { openProjectDb } from "@/db/dexie";
import { getOriginalEpubBytes } from "@/db/repo/projects";
import {
  rowToSegment,
  countPendingByChapter,
  countRunningByChapter,
} from "@/db/repo/segments";
import { listChapters, updateChapterNotes } from "@/db/repo/chapters";
import { listGlossaryEntries } from "@/db/repo/glossary";
import { resolveProjectGlossaryWithLore } from "@/lore/attach";
import {
  type SegmentRow,
  SegmentStatus,
  type SegmentStatusT,
} from "@/db/schema";
import { translateSegment } from "@/core/pipeline";
import {
  buildChapterImageMap,
  bytesToObjectUrl,
  findStandaloneImages,
  loadChapterAssets,
  mimeForPath,
  revokeAll,
  type ChapterImageMap,
  type StandaloneImage,
} from "@/formats/epub/images";
import { type InlineToken, type Segment } from "@/formats/epub/types";
import { hasTranslatableText, renderPreview } from "@/lib/preview";
import { formatCost, formatTokens } from "@/lib/numbers";
import {
  loadReaderPosition,
  saveReaderPosition,
} from "@/lib/reader_position";
import { type LLMProvider } from "@/llm/base";
import { buildProvider, type ProjectLlmOverrides } from "@/llm/factory";
import { type EmbeddingProvider } from "@/llm/embeddings/base";
import { buildEmbeddingProvider } from "@/llm/embeddings/factory";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/state/app";
import {
  translatingForProject,
  useTranslatingStore,
} from "@/state/translating";

const STATUS_GLYPH: Record<SegmentStatusT, string> = {
  pending: "·",
  translated: "○",
  validated: "○",
  approved: "●",
  flagged: "!",
};

interface ProviderHandle {
  provider: LLMProvider;
  model: string;
  reasoning_effort: "minimal" | "low" | "medium" | "high" | "none" | null;
}

export function ReaderRoute(): React.JSX.Element {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const project = useLiveQuery(
    async () => libraryDb().projects.get(projectId),
    [projectId],
  );
  const detail = useLiveQuery(
    async () => {
      if (!projectId) return null;
      const db = openProjectDb(projectId);
      return (await db.projects.get(projectId)) ?? null;
    },
    [projectId],
  );

  const chapters = useLiveQuery(
    async () => (projectId ? listChapters(projectId) : []),
    [projectId],
  );

  // Pending segment counts grouped by chapter id. Re-computed on every
  // segment write via `useLiveQuery`, so the sidebar badges stay live
  // while a batch is running.
  const pending_by_chapter = useLiveQuery(
    async () =>
      projectId
        ? countPendingByChapter(projectId)
        : new Map<string, number>(),
    [projectId],
    new Map<string, number>(),
  );

  // In-flight segment ids, scoped to this project. The translating
  // store is mutated by the per-segment `translateSegment` flow *and*
  // by the batch runner's `on_segment_start` / `on_segment_end`
  // callbacks, so this set captures every kind of "running" work
  // (single-segment retries from the Reader and chapter-wide batches
  // alike). We hoist the subscription up so the running-by-chapter
  // live query can read it as a dependency.
  const translating_ids = useTranslatingStore(translatingForProject(projectId));

  // Per-chapter "running" counts so the chapter list and reader header
  // can paint a distinct colour while segments are being translated
  // (vs the amber "still pending" colour). The query short-circuits
  // when nothing is in flight, so the common case costs nothing.
  const running_by_chapter = useLiveQuery(
    async () =>
      projectId
        ? countRunningByChapter(projectId, translating_ids)
        : new Map<string, number>(),
    [projectId, translating_ids],
    new Map<string, number>(),
  );

  // Glossary state — passed through to `translateSegment` so the LLM
  // sees the curator's locked terms and the cache key reflects glossary
  // edits. `useLiveQuery` re-fires on any glossary write.
  //
  // When an embedding provider is configured we keep the merged set
  // here for the legacy "show every Lore Book in the glossary panel"
  // UX, *but* the actual prompt-time merge happens per-segment inside
  // `translateSegment` via the `lore_retrieval` hook. So we always
  // return the flattened set regardless of `embedding_provider`.
  const glossary_state = useLiveQuery(
    async () => {
      if (!projectId) return [];
      const own = await listGlossaryEntries(projectId);
      return resolveProjectGlossaryWithLore(projectId, own);
    },
    [projectId],
    [],
  );

  // Project-side-only glossary state, used as the seed for per-segment
  // retrieval when an embedding provider is available. Kept as a
  // separate query so the displayed glossary panel still shows every
  // attached Lore-Book entry.
  const project_only_glossary_state = useLiveQuery(
    async () => {
      if (!projectId) return [];
      return listGlossaryEntries(projectId);
    },
    [projectId],
    [],
  );

  // Saved position (chapter + segment + scroll). Read once on mount;
  // we resolve the initial chapter against it so a curator who
  // navigates back to the Reader lands where they were last reading,
  // even if there's no `?ch=` in the URL. We *don't* want this to be
  // reactive — once the user picks a chapter we follow their lead,
  // not the stale localStorage value.
  const saved_position_ref = React.useRef(
    projectId ? loadReaderPosition(projectId) : null,
  );

  const requested_chapter_id = searchParams.get("ch");
  const current_chapter_id = React.useMemo(() => {
    if (!chapters || chapters.length === 0) return null;
    if (
      requested_chapter_id &&
      chapters.some((c) => c.id === requested_chapter_id)
    ) {
      return requested_chapter_id;
    }
    const saved = saved_position_ref.current?.chapter_id;
    if (saved && chapters.some((c) => c.id === saved)) {
      return saved;
    }
    return chapters[0].id;
  }, [chapters, requested_chapter_id]);

  // Pull every segment for the chapter; useLiveQuery re-runs after
  // pipeline writes so the panes always reflect the DB.
  const segments = useLiveQuery(
    async () => {
      if (!projectId || !current_chapter_id) return [] as SegmentRow[];
      const db = openProjectDb(projectId);
      return db.segments
        .where("[chapter_id+idx]")
        .between([current_chapter_id, 0], [current_chapter_id, Infinity])
        .toArray();
    },
    [projectId, current_chapter_id],
  );

  // Translatable segments — everything but image-only / structurally
  // empty ones, which the curator can't meaningfully accept anyway.
  const visible_segments = React.useMemo(
    () => (segments ?? []).filter((s) => hasTranslatableText(s.source_text)),
    [segments],
  );

  // Build the chapter's image lookup once per chapter switch. This
  // pulls the original ePub bytes from IndexedDB, parses the chapter
  // HTML, and builds a `(raw_src) => objectURL` resolver. We also
  // surface "standalone" images (image-only paragraphs/figures) so
  // the Reader can interleave them between segment cards.
  //
  // `status` makes failures visible instead of swallowing them. The
  // most common reasons we end up with no images are: (a) the
  // project was created before we started persisting source bytes
  // (`missing-source`), (b) the stored chapter href no longer maps
  // to anything in the spine (`missing-chapter`), or (c) the parser
  // threw (`error`). Each surfaces a hint in the Reader so the
  // curator knows whether to re-import.
  //
  // Memory hygiene: the effect cleans up object URLs when the chapter
  // changes or the component unmounts.
  type ImageLoadStatus =
    | "idle"
    | "loading"
    | "loaded"
    | "missing-source"
    | "missing-chapter"
    | "error";
  const [chapter_assets, setChapterAssets] = React.useState<{
    chapter_id: string | null;
    image_map: ChapterImageMap | null;
    standalone: StandaloneImage[];
    status: ImageLoadStatus;
    inline_count: number;
    resolved_count: number;
    error_message: string | null;
  }>({
    chapter_id: null,
    image_map: null,
    standalone: [],
    status: "idle",
    inline_count: 0,
    resolved_count: 0,
    error_message: null,
  });
  React.useEffect(() => {
    let cancelled = false;
    const cur_chapter_id = current_chapter_id;
    const cur_chapter = chapters?.find((c) => c.id === cur_chapter_id) ?? null;
    if (!projectId || !cur_chapter_id || !cur_chapter || !segments) {
      setChapterAssets((prev) => {
        if (prev.image_map) revokeAll(prev.image_map);
        return {
          chapter_id: null,
          image_map: null,
          standalone: [],
          status: "idle",
          inline_count: 0,
          resolved_count: 0,
          error_message: null,
        };
      });
      return;
    }
    setChapterAssets((prev) => {
      if (prev.chapter_id === cur_chapter_id && prev.status === "loading") {
        return prev;
      }
      // Don't revoke the previous map yet — we may end up reusing it
      // if the new load fails partway.
      return {
        chapter_id: cur_chapter_id,
        image_map: prev.chapter_id === cur_chapter_id ? prev.image_map : null,
        standalone:
          prev.chapter_id === cur_chapter_id ? prev.standalone : [],
        status: "loading",
        inline_count: 0,
        resolved_count: 0,
        error_message: null,
      };
    });
    void (async () => {
      try {
        const bytes = await getOriginalEpubBytes(projectId);
        if (cancelled) return;
        if (!bytes) {
          console.warn(
            `[Reader] no source ePub bytes for project ${projectId} — ` +
              `IndexedDB row source_blobs/'original' is missing. ` +
              `Re-import the ePub to restore image rendering.`,
          );
          setChapterAssets((prev) => {
            if (prev.image_map) revokeAll(prev.image_map);
            return {
              chapter_id: cur_chapter_id,
              image_map: null,
              standalone: [],
              status: "missing-source",
              inline_count: 0,
              resolved_count: 0,
              error_message: null,
            };
          });
          return;
        }
        const loaded = await loadChapterAssets(bytes, cur_chapter.href);
        if (cancelled) return;
        if (!loaded) {
          console.warn(
            `[Reader] chapter href "${cur_chapter.href}" not found in ` +
              `the ePub spine. The stored chapter row may be stale; ` +
              `try re-importing the project.`,
          );
          setChapterAssets((prev) => {
            if (prev.image_map) revokeAll(prev.image_map);
            return {
              chapter_id: cur_chapter_id,
              image_map: null,
              standalone: [],
              status: "missing-chapter",
              inline_count: 0,
              resolved_count: 0,
              error_message: null,
            };
          });
          return;
        }
        // `inline_skeleton` on disk is a JSON envelope:
        // `{ skeleton, host_path, host_part, host_total_parts }`.
        // Earlier this site naively `JSON.parse`d it and assumed the
        // result was already the skeleton array, which produced the
        // "skeleton is not iterable" error inside `buildChapterImageMap`
        // — the parse returned the *envelope object*, not the array.
        // Always go through `rowToSegment` so we get the same decoder
        // the rest of the Reader uses.
        const skeletons: InlineToken[][] = (segments ?? []).map(
          (row) => rowToSegment(row).inline_skeleton,
        );
        const image_map = buildChapterImageMap(
          loaded.book,
          loaded.chapter,
          skeletons,
        );
        // Pass the project's target language so the standalone image
        // walk skips the same already-localized blocks the segmenter
        // skipped at intake; otherwise we'd over-count hosts and
        // splice images one-too-many positions late.
        const standalone = findStandaloneImages(loaded.chapter, {
          target_lang: detail?.target_lang ?? null,
        });
        // Pre-warm the standalone images so they share object URLs
        // with the inline ones (prevents double-decoding when the same
        // image appears both inline *and* standalone, which it does in
        // some publisher-built ePubs).
        const missing_zip_entries: string[] = [];
        for (const item of standalone) {
          if (image_map.byResolved.has(item.resolved)) continue;
          const data = loaded.book.zip_entries.get(item.resolved);
          if (!data) {
            missing_zip_entries.push(item.resolved);
            continue;
          }
          const url = bytesToObjectUrl(data, mimeForPath(item.resolved));
          if (!url) continue;
          image_map.byResolved.set(item.resolved, url);
          image_map.urls.push(url);
        }
        if (missing_zip_entries.length > 0) {
          console.warn(
            `[Reader] ${missing_zip_entries.length} standalone image ` +
              `path(s) missing from ePub ZIP for chapter ` +
              `${cur_chapter.href}: ${missing_zip_entries
                .slice(0, 5)
                .join(", ")}${missing_zip_entries.length > 5 ? " …" : ""}`,
          );
        }
        if (cancelled) {
          revokeAll(image_map);
          return;
        }
        // One-line summary so the curator (or a maintainer reading the
        // console during a debug session) can confirm at a glance how
        // many images each chapter contributed without dumping the
        // full state.
        console.info(
          `[Reader] chapter "${cur_chapter.href}" loaded: ` +
            `${standalone.length} standalone image(s), ` +
            `${image_map.byRawSrc.size} inline image(s), ` +
            `${image_map.byResolved.size} object URL(s) minted.`,
        );
        setChapterAssets((prev) => {
          if (prev.image_map && prev.image_map !== image_map) {
            revokeAll(prev.image_map);
          }
          return {
            chapter_id: cur_chapter_id,
            image_map,
            standalone,
            status: "loaded",
            inline_count: image_map.byRawSrc.size,
            resolved_count: image_map.byResolved.size,
            error_message: null,
          };
        });
      } catch (err) {
        if (cancelled) return;
        // Best-effort: failing to load images should never break
        // translation. Log and fall back to text markers.
        console.warn("[Reader] failed to load chapter images", err);
        setChapterAssets((prev) => {
          if (prev.image_map) revokeAll(prev.image_map);
          return {
            chapter_id: cur_chapter_id,
            image_map: null,
            standalone: [],
            status: "error",
            inline_count: 0,
            resolved_count: 0,
            error_message:
              err instanceof Error ? err.message : String(err),
          };
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, current_chapter_id, chapters, segments, detail?.target_lang]);

  React.useEffect(() => {
    return () => {
      // Final cleanup on unmount.
      if (chapter_assets.image_map) revokeAll(chapter_assets.image_map);
    };
    // We *intentionally* run only on unmount — chapter-switch cleanup
    // happens inside the loader effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const image_resolver = React.useCallback(
    (raw_src: string): string | null => {
      const map = chapter_assets.image_map;
      if (!map) return null;
      return map.byRawSrc.get(raw_src) ?? null;
    },
    [chapter_assets.image_map],
  );

  const [active_segment_id, setActiveSegmentId] = React.useState<string | null>(
    null,
  );
  React.useEffect(() => {
    if (!visible_segments.length) {
      setActiveSegmentId(null);
      return;
    }
    if (!visible_segments.some((s) => s.id === active_segment_id)) {
      // If the saved position points at a segment in this chapter,
      // restore it before falling back to the first segment. Once a
      // valid restore happens, clear the ref so subsequent chapter
      // changes don't keep dragging us back.
      const saved = saved_position_ref.current;
      if (
        saved &&
        saved.chapter_id === current_chapter_id &&
        saved.active_segment_id &&
        visible_segments.some((s) => s.id === saved.active_segment_id)
      ) {
        setActiveSegmentId(saved.active_segment_id);
        return;
      }
      setActiveSegmentId(visible_segments[0].id);
    }
  }, [visible_segments, active_segment_id, current_chapter_id]);

  const llm_state = useAppStore((s) => s.llm);
  const mock_mode = useAppStore((s) => s.mock_mode);
  const [provider_handle, setProviderHandle] = React.useState<
    ProviderHandle | null
  >(null);
  const [provider_error, setProviderError] = React.useState<string | null>(null);
  // Optional embedding provider for per-segment Lore-Book retrieval.
  // `null` means embeddings are disabled or failed to build — the
  // pipeline gracefully falls back to the legacy flatten-everything
  // merge when this is null.
  const [embedding_provider, setEmbeddingProvider] = React.useState<
    EmbeddingProvider | null
  >(null);
  // The global translating set is already subscribed above (so the
  // running-by-chapter query can depend on it). Here we just need
  // the mutators that the per-segment translate flow uses.
  const addTranslating = useTranslatingStore((s) => s.add);
  const removeTranslating = useTranslatingStore((s) => s.remove);
  const [edit_segment_id, setEditSegmentId] = React.useState<string | null>(null);
  const [batch_open, setBatchOpen] = React.useState(false);

  // Build the LLM provider lazily — `buildProvider` reads the live
  // library row, which already contains everything Settings persists.
  // We rebuild whenever the settings change to honor edits without a
  // hard reload.
  React.useEffect(() => {
    let cancelled = false;
    setProviderError(null);
    void (async () => {
      try {
        const overrides = await readProjectOverrides(projectId);
        const built = await buildProvider({
          mock: mock_mode,
          overrides,
        });
        if (cancelled) return;
        const model = built.resolved?.translator_model ?? "mock-model";
        const reasoning_effort = built.resolved?.reasoning_effort ?? null;
        setProviderHandle({ provider: built.provider, model, reasoning_effort });
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setProviderHandle(null);
        setProviderError(msg);
      }
      // Embedding provider is best-effort: a build failure should
      // never break the inline-translate path. We just silently fall
      // back to the legacy v1 merge when embeddings can't be loaded.
      try {
        const overrides = await readProjectOverrides(projectId);
        const emb = await buildEmbeddingProvider({
          mock: mock_mode,
          overrides: overrides?.embedding ?? null,
        });
        if (!cancelled) {
          setEmbeddingProvider(emb.provider);
        }
      } catch {
        if (!cancelled) {
          setEmbeddingProvider(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, mock_mode, llm_state]);

  const setChapter = React.useCallback(
    (chapter_id: string) => {
      const next = new URLSearchParams(searchParams);
      next.set("ch", chapter_id);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const sourcePaneRef = React.useRef<HTMLDivElement | null>(null);
  const targetPaneRef = React.useRef<HTMLDivElement | null>(null);

  const runTranslation = React.useCallback(
    async (
      segment_row: SegmentRow,
      options: { bypass_cache?: boolean } = {},
    ) => {
      if (!projectId || !provider_handle || !detail) {
        if (provider_error) {
          toast.error(`Cannot translate: ${provider_error}`);
        }
        return;
      }
      const seg = rowToSegment(segment_row);
      // Inline-translate path: pull the chapter notes too, so curators
      // who edit notes mid-session see the updated guidance applied
      // to every retry. The cache key already incorporates the notes,
      // so we naturally avoid replaying stale translations.
      const chapter_row = await openProjectDb(projectId)
        .chapters.get(seg.chapter_id);
      const chapter_notes = chapter_row?.notes?.trim() || null;
      addTranslating(projectId, seg.id);
      try {
        // When an embedding provider is wired up, hand the pipeline
        // the project-side glossary only and let it merge attached
        // Lore-Book entries via cosine top-K. Otherwise pass the
        // already-flattened state for the legacy v1 path.
        const using_retrieval = !!embedding_provider;
        const passed_glossary = using_retrieval
          ? project_only_glossary_state ?? []
          : glossary_state ?? [];
        const outcome = await translateSegment({
          project_id: projectId,
          source_lang: detail.source_lang,
          target_lang: detail.target_lang,
          style_guide: detail.style_guide,
          chapter_notes,
          segment: seg,
          provider: provider_handle.provider,
          options: {
            model: provider_handle.model,
            reasoning_effort: provider_handle.reasoning_effort,
            bypass_cache: options.bypass_cache,
            glossary_state: passed_glossary,
            lore_retrieval: embedding_provider
              ? { provider: embedding_provider }
              : null,
            // Phase 3: same provider drives `relevant` context mode
            // when the curator hasn't attached a Lore Book.
            embedding_provider: embedding_provider ?? null,
          },
        });
        if (outcome.violations.length) {
          toast.warning(
            `Flagged · ${outcome.violations.length} glossary violation${outcome.violations.length === 1 ? "" : "s"}`,
          );
        } else if (outcome.cache_hit) {
          toast.success("Translation reused (cache hit).");
        } else if (outcome.trivial) {
          toast.message("Trivially-empty segment — copied verbatim.");
        } else {
          toast.success(
            `Translated · ${formatTokens(outcome.prompt_tokens)}→${formatTokens(outcome.completion_tokens)} tok · ${formatCost(outcome.cost_usd, { decimals: 6 })}`,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Translation failed: ${truncateForToast(msg)}`);
      } finally {
        removeTranslating(projectId, seg.id);
      }
    },
    [
      projectId,
      provider_handle,
      provider_error,
      detail,
      glossary_state,
      project_only_glossary_state,
      embedding_provider,
      addTranslating,
      removeTranslating,
    ],
  );

  const acceptSegment = React.useCallback(
    async (segment_row: SegmentRow) => {
      if (!segment_row.target_text) {
        toast.error("Nothing to accept — translate the segment first.");
        return;
      }
      const db = openProjectDb(projectId);
      await db.transaction("rw", db.segments, db.events, async () => {
        await db.segments.update(segment_row.id, {
          status: SegmentStatus.APPROVED,
        });
        await db.events.add({
          project_id: projectId,
          ts: Date.now(),
          kind: "segment.approved",
          payload_json: JSON.stringify({ segment_id: segment_row.id }),
        });
      });
      toast.success("Segment approved.");
    },
    [projectId],
  );

  const saveEdit = React.useCallback(
    async (segment_id: string, target_text: string) => {
      const db = openProjectDb(projectId);
      await db.transaction("rw", db.segments, db.events, async () => {
        await db.segments.update(segment_id, {
          target_text,
          status: SegmentStatus.APPROVED,
        });
        await db.events.add({
          project_id: projectId,
          ts: Date.now(),
          kind: "segment.edited",
          payload_json: JSON.stringify({ segment_id }),
        });
      });
      toast.success("Saved edit.");
      setEditSegmentId(null);
    },
    [projectId],
  );

  // Keyboard navigation: ↑/↓ between segments, t = translate, r = retry,
  // a = accept, e = edit. Mirrors the Reader hotkeys in the Python tool.
  React.useEffect(() => {
    if (!visible_segments.length) return;
    const onKey = (ev: KeyboardEvent): void => {
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const idx = visible_segments.findIndex((s) => s.id === active_segment_id);
      const seg = idx >= 0 ? visible_segments[idx] : null;
      if (ev.key === "ArrowDown" || ev.key === "j") {
        ev.preventDefault();
        const next = visible_segments[Math.min(idx + 1, visible_segments.length - 1)];
        if (next) setActiveSegmentId(next.id);
      } else if (ev.key === "ArrowUp" || ev.key === "k") {
        ev.preventDefault();
        const prev = visible_segments[Math.max(idx - 1, 0)];
        if (prev) setActiveSegmentId(prev.id);
      } else if (ev.key === "T" && ev.shiftKey) {
        // Shift+T = translate the entire current chapter via the
        // existing batch pipeline. Opens the modal so the curator
        // can confirm concurrency / budget; the chapter scope is
        // pre-filled.
        ev.preventDefault();
        if (current_chapter_id) setBatchOpen(true);
      } else if (ev.key === "t" && !ev.shiftKey && seg) {
        ev.preventDefault();
        void runTranslation(seg);
      } else if (ev.key === "r" && seg) {
        ev.preventDefault();
        void runTranslation(seg, { bypass_cache: true });
      } else if (ev.key === "a" && seg) {
        ev.preventDefault();
        void acceptSegment(seg);
      } else if (ev.key === "e" && seg) {
        ev.preventDefault();
        setEditSegmentId(seg.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    active_segment_id,
    current_chapter_id,
    visible_segments,
    runTranslation,
    acceptSegment,
  ]);

  // Scroll source/target panes in lockstep at the segment level.
  //
  // The algorithm picks a "from" card that contains `scrollTop`, records
  // the fractional offset within it, and applies the same fraction to
  // the matching "to" card. Two edge cases need explicit handling that
  // pure card-anchoring misses, both surfaced as "right pane stops a
  // few pixels short when the left goes all the way up":
  //
  // 1. Top padding gap. The pane has `py-2`, so the first card's
  //    `offsetTop` is ~8px. While `scrollTop` is in the [0, 8] range,
  //    no card satisfies `top <= scrollTop < bottom` *and* the
  //    "scrollTop >= bottom" branch never fires either, so the loop
  //    leaves `anchor === null` and we bail without syncing. The
  //    target pane stays at its last-anchored position rather than
  //    following the source to the absolute top.
  // 2. Trailing padding / bottom margin. Same problem mirrored at the
  //    other end: at `scrollTop === scrollHeight - clientHeight` the
  //    loop's last provisional anchor is `{frac: 1}` of the last card,
  //    but the source has actually scrolled past that card's bottom by
  //    a few pixels of padding, so the panes line up just shy of the
  //    real bottom.
  //
  // Snap to the absolute extremes for both cases so top/bottom always
  // mirror exactly, and fall back to `frac=0` on the first card if the
  // loop trips into "above this card" before any anchor was set
  // (covers the in-between sub-padding pixels too).
  const syncing_ref = React.useRef(false);
  const onPaneScroll = React.useCallback(
    (from: "source" | "target") => {
      if (syncing_ref.current) return;
      const fromPane =
        from === "source" ? sourcePaneRef.current : targetPaneRef.current;
      const toPane =
        from === "source" ? targetPaneRef.current : sourcePaneRef.current;
      if (!fromPane || !toPane) return;
      const fromCards = fromPane.querySelectorAll<HTMLDivElement>(
        "[data-segment-id]",
      );
      const toCards = toPane.querySelectorAll<HTMLDivElement>(
        "[data-segment-id]",
      );
      if (!fromCards.length || !toCards.length) return;
      const scroll_top = fromPane.scrollTop;
      const max_from = Math.max(
        0,
        fromPane.scrollHeight - fromPane.clientHeight,
      );
      const max_to = Math.max(0, toPane.scrollHeight - toPane.clientHeight);

      let next_y: number;
      if (scroll_top <= 0) {
        next_y = 0;
      } else if (scroll_top >= max_from - 0.5) {
        next_y = max_to;
      } else {
        let anchor: { id: string; frac: number } | null = null;
        for (const card of fromCards) {
          const top = card.offsetTop;
          const bottom = top + card.offsetHeight;
          if (scroll_top < top) {
            // Above this card. If we already provisional-anchored on
            // the previous card (frac=1), keep it; otherwise we're
            // above the first card, so anchor at its start so the
            // target follows through the leading padding gap.
            if (!anchor) {
              anchor = { id: card.dataset.segmentId ?? "", frac: 0 };
            }
            break;
          }
          if (scroll_top < bottom) {
            const id = card.dataset.segmentId ?? "";
            const frac = card.offsetHeight
              ? (scroll_top - top) / card.offsetHeight
              : 0;
            anchor = { id, frac };
            break;
          }
          // scroll_top >= bottom — provisional anchor at end of this
          // card; superseded if a later card actually contains
          // `scroll_top`.
          anchor = { id: card.dataset.segmentId ?? "", frac: 1 };
        }
        if (!anchor) return;
        const target_card = Array.from(toCards).find(
          (c) => c.dataset.segmentId === anchor!.id,
        );
        if (!target_card) return;
        next_y =
          target_card.offsetTop + anchor.frac * target_card.offsetHeight;
      }

      next_y = Math.max(0, Math.min(max_to, next_y));
      if (Math.abs(toPane.scrollTop - next_y) < 1) return;
      syncing_ref.current = true;
      toPane.scrollTop = next_y;
      // Release on the next frame so the watcher doesn't recurse on a
      // bouncy clamp.
      requestAnimationFrame(() => {
        syncing_ref.current = false;
      });
    },
    [],
  );

  // Center the active segment in its pane when it changes.
  React.useEffect(() => {
    if (!active_segment_id) return;
    const sp = sourcePaneRef.current;
    if (!sp) return;
    const card = sp.querySelector<HTMLDivElement>(
      `[data-segment-id="${cssEscape(active_segment_id)}"]`,
    );
    if (!card) return;
    syncing_ref.current = true;
    card.scrollIntoView({ block: "nearest", behavior: "auto" });
    requestAnimationFrame(() => {
      // After the source moves, mirror to the target.
      onPaneScroll("source");
      syncing_ref.current = false;
    });
  }, [active_segment_id, onPaneScroll]);

  // One-shot scroll restore: when the segments list first appears for
  // the saved chapter, jump the source pane to the saved offset, then
  // null the ref so we don't keep clobbering legitimate scrolls.
  // We do this *after* the center-active-segment effect by running on
  // the same dependency list and bailing if the ref has already been
  // consumed.
  React.useLayoutEffect(() => {
    const saved = saved_position_ref.current;
    if (!saved) return;
    if (!current_chapter_id || saved.chapter_id !== current_chapter_id) return;
    if (!visible_segments.length) return;
    const sp = sourcePaneRef.current;
    if (!sp) return;
    if (saved.scroll_top > 0) {
      syncing_ref.current = true;
      sp.scrollTop = saved.scroll_top;
      requestAnimationFrame(() => {
        onPaneScroll("source");
        syncing_ref.current = false;
      });
    }
    saved_position_ref.current = null;
  }, [visible_segments, current_chapter_id, onPaneScroll]);

  // Persist position whenever chapter, active segment, or scroll
  // change. We debounce scroll writes to keep storage churn low; the
  // chapter / segment writes go through immediately because they're
  // discrete events.
  React.useEffect(() => {
    if (!projectId || !current_chapter_id) return;
    const sp = sourcePaneRef.current;
    saveReaderPosition(projectId, {
      chapter_id: current_chapter_id,
      active_segment_id,
      scroll_top: sp?.scrollTop ?? 0,
    });
  }, [projectId, current_chapter_id, active_segment_id]);

  React.useEffect(() => {
    if (!projectId) return;
    const sp = sourcePaneRef.current;
    if (!sp) return;
    let timer: number | null = null;
    const onScroll = (): void => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!current_chapter_id) return;
        saveReaderPosition(projectId, {
          chapter_id: current_chapter_id,
          active_segment_id,
          scroll_top: sp.scrollTop,
        });
      }, 250);
    };
    sp.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      sp.removeEventListener("scroll", onScroll);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [projectId, current_chapter_id, active_segment_id]);

  if (project === undefined || detail === undefined || chapters === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading reader…
      </div>
    );
  }
  if (!project || !detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <span>Project not found.</span>
        <Button variant="outline" asChild>
          <Link to="/">
            <ArrowLeft className="size-4" /> Back to projects
          </Link>
        </Button>
      </div>
    );
  }

  const active_segment_row =
    visible_segments.find((s) => s.id === active_segment_id) ?? null;
  const editing_row =
    edit_segment_id != null
      ? (segments?.find((s) => s.id === edit_segment_id) ?? null)
      : null;
  const chapter_pending_count = (segments ?? []).filter(
    (s) => s.status === SegmentStatus.PENDING,
  ).length;
  // Live count of how many of *this* chapter's segments are mid-flight.
  // Reads off the same global translating set the chapter list uses,
  // so the header badge and the sidebar pip stay in lockstep.
  const chapter_running_count = current_chapter_id
    ? (running_by_chapter?.get(current_chapter_id) ?? 0)
    : 0;
  const current_chapter =
    chapters?.find((c) => c.id === current_chapter_id) ?? null;
  const current_chapter_label =
    current_chapter?.title?.trim() ||
    (current_chapter
      ? `Chapter ${current_chapter.spine_idx + 1}`
      : null);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => navigate(`/project/${projectId}`)}
            className="flex size-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent"
            aria-label="Back to dashboard"
          >
            <ArrowLeft className="size-4" />
          </button>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold">
                {project.name}
              </span>
              {current_chapter_label ? (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <span className="min-w-0 truncate text-sm font-medium text-foreground/90">
                    {current_chapter_label}
                  </span>
                </>
              ) : null}
              {chapter_running_count > 0 ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-sky-700 dark:text-sky-300"
                  title={`${chapter_running_count} segment${
                    chapter_running_count === 1 ? "" : "s"
                  } translating now${
                    chapter_pending_count > chapter_running_count
                      ? ` · ${
                          chapter_pending_count - chapter_running_count
                        } still queued`
                      : ""
                  }`}
                >
                  <span
                    aria-hidden
                    className="size-1.5 animate-pulse rounded-full bg-sky-500"
                  />
                  {chapter_running_count} translating
                  {chapter_pending_count > chapter_running_count
                    ? ` · ${chapter_pending_count} pending`
                    : ""}
                </span>
              ) : chapter_pending_count > 0 ? (
                <span
                  className="rounded-full bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-700 dark:text-amber-300"
                  title={`${chapter_pending_count} pending segment${
                    chapter_pending_count === 1 ? "" : "s"
                  } in this chapter`}
                >
                  {chapter_pending_count} pending
                </span>
              ) : null}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {project.source_lang} → {project.target_lang}
              {provider_handle ? ` · ${provider_handle.model}` : null}
              {provider_error ? (
                <span className="text-destructive"> · {provider_error}</span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {current_chapter ? (
            <ChapterNotesButton
              project_id={projectId}
              chapter_id={current_chapter.id}
              has_notes={Boolean(current_chapter.notes?.trim())}
            />
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setBatchOpen(true)}
            disabled={!current_chapter_id || chapter_pending_count === 0}
            title={
              chapter_pending_count === 0
                ? "No pending segments in this chapter"
                : `Translate the remaining ${chapter_pending_count} pending segment${chapter_pending_count === 1 ? "" : "s"} in this chapter`
            }
            className="gap-1.5"
          >
            <Layers className="size-3.5" />
            Translate chapter
            {chapter_pending_count > 0 ? (
              <span className="ml-0.5 rounded-full bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary">
                {chapter_pending_count}
              </span>
            ) : null}
          </Button>
          <div className="text-[11px] text-muted-foreground">
            ↑/↓ navigate · t translate · ⇧T chapter · r retry · a accept · e
            edit
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[14rem_minmax(0,1fr)_minmax(0,1fr)] gap-0">
        <ChapterList
          chapters={chapters}
          current_chapter_id={current_chapter_id}
          pending_by_chapter={pending_by_chapter}
          running_by_chapter={running_by_chapter}
          onSelect={setChapter}
        />
        <SegmentPane
          ref={sourcePaneRef}
          title="Source"
          side="source"
          segments={visible_segments}
          standalone_images={chapter_assets.standalone}
          image_map={chapter_assets.image_map}
          image_resolver={image_resolver}
          image_status={chapter_assets.status}
          image_inline_count={chapter_assets.inline_count}
          image_resolved_count={chapter_assets.resolved_count}
          image_error_message={chapter_assets.error_message}
          active_segment_id={active_segment_id}
          translating_ids={translating_ids}
          onSelect={setActiveSegmentId}
          onScroll={() => onPaneScroll("source")}
        />
        <SegmentPane
          ref={targetPaneRef}
          title="Target"
          side="target"
          segments={visible_segments}
          standalone_images={chapter_assets.standalone}
          image_map={chapter_assets.image_map}
          image_resolver={image_resolver}
          image_status={chapter_assets.status}
          image_inline_count={chapter_assets.inline_count}
          image_resolved_count={chapter_assets.resolved_count}
          image_error_message={chapter_assets.error_message}
          active_segment_id={active_segment_id}
          translating_ids={translating_ids}
          onSelect={setActiveSegmentId}
          onScroll={() => onPaneScroll("target")}
        />
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t px-4 py-3">
        <Button
          variant="default"
          size="sm"
          disabled={!active_segment_row || !provider_handle}
          onClick={() =>
            active_segment_row && void runTranslation(active_segment_row)
          }
        >
          <Play className="size-4" /> Translate
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!active_segment_row || !provider_handle}
          onClick={() =>
            active_segment_row &&
            void runTranslation(active_segment_row, { bypass_cache: true })
          }
        >
          <RotateCcw className="size-4" /> Retry
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!active_segment_row?.target_text}
          onClick={() =>
            active_segment_row && void acceptSegment(active_segment_row)
          }
        >
          <Check className="size-4" /> Accept
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!active_segment_row}
          onClick={() =>
            active_segment_row && setEditSegmentId(active_segment_row.id)
          }
        >
          <Pencil className="size-4" /> Edit
        </Button>
        <div className="ml-auto text-[11px] text-muted-foreground">
          {visible_segments.length} segment
          {visible_segments.length === 1 ? "" : "s"} ·{" "}
          {visible_segments.filter((s) => s.target_text).length} translated ·{" "}
          {
            visible_segments.filter((s) => s.status === SegmentStatus.APPROVED)
              .length
          }{" "}
          approved
        </div>
      </footer>

      {editing_row ? (
        <EditTargetDialog
          row={editing_row}
          onCancel={() => setEditSegmentId(null)}
          onSave={(text) => void saveEdit(editing_row.id, text)}
        />
      ) : null}

      <BatchModal
        project_id={projectId}
        chapter_ids={current_chapter_id ? [current_chapter_id] : null}
        default_budget_usd={detail.budget_usd ?? null}
        pending_count={chapter_pending_count}
        open={batch_open}
        onOpenChange={setBatchOpen}
      />
    </div>
  );
}

interface ChapterListProps {
  chapters: {
    id: string;
    spine_idx: number;
    title: string | null;
    href: string;
    notes?: string | null;
  }[];
  current_chapter_id: string | null;
  pending_by_chapter: Map<string, number> | undefined;
  running_by_chapter: Map<string, number> | undefined;
  onSelect(id: string): void;
}

function ChapterList({
  chapters,
  current_chapter_id,
  pending_by_chapter,
  running_by_chapter,
  onSelect,
}: ChapterListProps): React.JSX.Element {
  return (
    <aside className="flex min-h-0 flex-col border-r bg-card/40">
      <div className="border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Chapters
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {chapters.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">
            (no chapters)
          </div>
        ) : (
          chapters.map((c) => {
            const is_current = c.id === current_chapter_id;
            const label = c.title?.trim() || `Chapter ${c.spine_idx + 1}`;
            const pending = pending_by_chapter?.get(c.id) ?? 0;
            const running = running_by_chapter?.get(c.id) ?? 0;
            const has_notes = Boolean(c.notes?.trim());
            const tooltip =
              running > 0
                ? `${running} translating now${
                    pending > running
                      ? ` · ${pending - running} still queued`
                      : ""
                  }`
                : pending > 0
                  ? `${pending} pending segment${pending === 1 ? "" : "s"}`
                  : "All segments translated";
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelect(c.id)}
                title={tooltip}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                  is_current
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/40",
                )}
              >
                <span className="w-6 shrink-0 font-mono text-[11px] text-muted-foreground">
                  {c.spine_idx + 1}.
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {label}
                  {has_notes ? (
                    <span
                      className="ml-1 align-middle text-[10px] text-muted-foreground"
                      title="Has chapter notes"
                      aria-label="Has chapter notes"
                    >
                      📝
                    </span>
                  ) : null}
                </span>
                {running > 0 ? (
                  // "Translating now" — sky-blue + a small pulsing dot
                  // so the curator can spot the active chapter at a
                  // glance, even with the chapter list scrolled.
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px]",
                      is_current
                        ? "bg-background/60 text-foreground"
                        : "bg-sky-500/15 text-sky-700 dark:text-sky-300",
                    )}
                    aria-label={`${running} translating`}
                  >
                    <span
                      aria-hidden
                      className="size-1.5 animate-pulse rounded-full bg-sky-500"
                    />
                    {running}
                    {pending > running ? `/${pending}` : ""}
                  </span>
                ) : pending > 0 ? (
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px]",
                      is_current
                        ? "bg-background/60 text-foreground"
                        : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
                    )}
                    aria-label={`${pending} pending`}
                  >
                    {pending}
                  </span>
                ) : (
                  <span
                    aria-hidden
                    className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400"
                    title="All segments translated"
                  >
                    ✓
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}

interface SegmentPaneProps {
  title: string;
  side: "source" | "target";
  segments: SegmentRow[];
  standalone_images: StandaloneImage[];
  image_map: ChapterImageMap | null;
  image_resolver: (raw_src: string) => string | null | undefined;
  image_status:
    | "idle"
    | "loading"
    | "loaded"
    | "missing-source"
    | "missing-chapter"
    | "error";
  image_inline_count: number;
  image_resolved_count: number;
  image_error_message: string | null;
  active_segment_id: string | null;
  translating_ids: ReadonlySet<string>;
  onSelect(id: string): void;
  onScroll(): void;
}

const SegmentPane = React.forwardRef<HTMLDivElement, SegmentPaneProps>(
  function SegmentPane(
    {
      title,
      side,
      segments,
      standalone_images,
      image_map,
      image_resolver,
      image_status,
      image_inline_count,
      image_resolved_count,
      image_error_message,
      active_segment_id,
      translating_ids,
      onSelect,
      onScroll,
    },
    ref,
  ) {
    // Build the rendered feed: segment cards + standalone-image cards.
    //
    // We don't know the segment's exact DOM offset in the original
    // chapter (the segmenter doesn't store it), so the simplest
    // proxy is "how many standalone images appeared *before* this
    // segment when walking the chapter in document order." Because
    // standalone images are filtered out of the segment list anyway,
    // we just spread them evenly: every Nth segment gets the next
    // queued image inserted before it. For chapters with one or two
    // illustrations (the common case for novels) this lands the image
    // near where the curator would expect to see it. For dense visual
    // chapters the order is approximate — the image still exists, it
    // just sits next to a sibling segment rather than the exact
    // paragraph it lived in originally.
    const feed = React.useMemo(
      () => interleaveStandaloneImages(segments, standalone_images),
      [segments, standalone_images],
    );
    return (
      <section className="flex min-h-0 flex-col">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span>{title}</span>
          {side === "source" ? (
            <ImageStatusBadge
              status={image_status}
              standalone_count={standalone_images.length}
              inline_count={image_inline_count}
              resolved_count={image_resolved_count}
              error_message={image_error_message}
            />
          ) : null}
        </div>
        {side === "source" && image_status === "missing-source" ? (
          <div className="border-b bg-warning/10 px-3 py-2 text-[11px] text-warning-foreground">
            <strong>ePub source bytes are missing</strong> for this project,
            so images can't be rendered. Re-import the project from its
            original .epub to restore image rendering. (The translation
            data itself is unaffected.)
          </div>
        ) : null}
        {side === "source" && image_status === "missing-chapter" ? (
          <div className="border-b bg-warning/10 px-3 py-2 text-[11px] text-warning-foreground">
            <strong>This chapter's source HTML can't be located</strong> in
            the stored ePub. The chapter row may be stale; re-import the
            project to restore image rendering.
          </div>
        ) : null}
        {side === "source" && image_status === "error" ? (
          <div className="border-b bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            <strong>Failed to load chapter images.</strong>{" "}
            {image_error_message ?? "(no error details)"}
          </div>
        ) : null}
        <div
          ref={ref}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        >
          {segments.length === 0 && standalone_images.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              (no translatable segments)
            </div>
          ) : (
            feed.map((item) => {
              if (item.kind === "segment") {
                return (
                  <SegmentCard
                    key={item.row.id}
                    row={item.row}
                    side={side}
                    is_current={item.row.id === active_segment_id}
                    is_translating={translating_ids.has(item.row.id)}
                    image_resolver={image_resolver}
                    onClick={() => onSelect(item.row.id)}
                  />
                );
              }
              const url =
                image_map?.byResolved.get(item.image.resolved) ?? null;
              return (
                <StandaloneImageCard
                  key={`img-${item.image.splice_at}-${item.image.resolved}`}
                  image={item.image}
                  url={url}
                />
              );
            })
          )}
        </div>
      </section>
    );
  },
);

type ReaderFeedItem =
  | { kind: "segment"; row: SegmentRow }
  | { kind: "image"; image: StandaloneImage };

/**
 * Splice standalone images into the segment list at host-anchored
 * positions.
 *
 * Each `StandaloneImage` carries a `splice_at` value: the count of
 * non-empty translatable hosts that preceded it in DOM order. We map
 * that to "the first segment idx produced by host K" using the
 * segments' own `host_path`, so a leading frontispiece lands above
 * segment 0, a trailing tailpiece lands after the last segment, and
 * mid-chapter illustrations sit next to the same paragraphs they
 * neighboured in the original ePub. Sentence-splitting is honoured
 * automatically: a host that produced 3 segments still counts as one
 * host, but the image splices in front of the *first* of those 3 so
 * the illustration doesn't get stranded mid-paragraph.
 */
function interleaveStandaloneImages(
  segments: SegmentRow[],
  images: StandaloneImage[],
): ReaderFeedItem[] {
  if (images.length === 0) {
    return segments.map((row) => ({ kind: "segment", row }) as ReaderFeedItem);
  }
  if (segments.length === 0) {
    return images.map(
      (image) => ({ kind: "image", image }) as ReaderFeedItem,
    );
  }

  // Build a DOM-order list of "first segment idx per host" by scanning
  // the segments table. The first time we see a `host_path` we record
  // the segment idx; subsequent segments from the same host (sentence
  // splits) reuse that anchor. This relies on `segments` being sorted
  // by `idx`, which the live query already guarantees.
  const host_first_seg_idx: number[] = [];
  const seen_host_paths = new Set<string>();
  for (const row of segments) {
    const seg = rowToSegment(row);
    if (!seen_host_paths.has(seg.host_path)) {
      seen_host_paths.add(seg.host_path);
      host_first_seg_idx.push(seg.idx);
    }
  }

  const ordered = [...images].sort((a, b) => a.splice_at - b.splice_at);
  const insert_before = new Map<number, StandaloneImage[]>();
  const tail: StandaloneImage[] = [];
  for (const img of ordered) {
    if (img.splice_at < host_first_seg_idx.length) {
      const target_idx = host_first_seg_idx[img.splice_at]!;
      const arr = insert_before.get(target_idx) ?? [];
      arr.push(img);
      insert_before.set(target_idx, arr);
    } else {
      // Image trails every translatable host (or the host classifier
      // diverged from the segmenter for edge-case markup). Append it
      // so the curator at least sees the picture.
      tail.push(img);
    }
  }

  const out: ReaderFeedItem[] = [];
  for (const row of segments) {
    const before = insert_before.get(row.idx);
    if (before) for (const image of before) out.push({ kind: "image", image });
    out.push({ kind: "segment", row });
  }
  for (const image of tail) out.push({ kind: "image", image });
  return out;
}

interface ImageStatusBadgeProps {
  status:
    | "idle"
    | "loading"
    | "loaded"
    | "missing-source"
    | "missing-chapter"
    | "error";
  standalone_count: number;
  inline_count: number;
  resolved_count: number;
  error_message: string | null;
}

/**
 * Compact status pill for image loading. Always visible in the
 * source pane header so curators (and us, when debugging) can tell
 * at a glance whether the image pipeline ran. The hover title
 * spells out exactly what happened — handy when the visible pill
 * is just "0 imgs" and you need to know *why*.
 */
function ImageStatusBadge({
  status,
  standalone_count,
  inline_count,
  resolved_count,
  error_message,
}: ImageStatusBadgeProps): React.JSX.Element | null {
  let label: string;
  let title: string;
  let tone: "neutral" | "warning" | "danger" = "neutral";
  switch (status) {
    case "idle":
      return null;
    case "loading":
      label = "loading…";
      title = "Loading chapter images…";
      break;
    case "loaded": {
      const total = standalone_count + inline_count;
      label = `${total} img${total === 1 ? "" : "s"}`;
      title =
        `Images for this chapter:\n` +
        `  ${standalone_count} standalone (image-only blocks)\n` +
        `  ${inline_count} inline (mid-paragraph)\n` +
        `  ${resolved_count} object URL(s) minted`;
      if (total === 0) {
        title += "\n(this chapter has no images, or none survived ZIP lookup)";
      }
      break;
    }
    case "missing-source":
      label = "no source";
      title =
        "ePub source bytes are missing for this project. Re-import to restore images.";
      tone = "warning";
      break;
    case "missing-chapter":
      label = "missing in spine";
      title =
        "This chapter's source HTML can't be located in the stored ePub.";
      tone = "warning";
      break;
    case "error":
      label = "error";
      title = `Failed to load images: ${error_message ?? "(no details)"}`;
      tone = "danger";
      break;
  }
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 font-mono text-[10px] uppercase",
        tone === "neutral" && "bg-muted text-muted-foreground",
        tone === "warning" && "bg-warning/15 text-warning",
        tone === "danger" && "bg-destructive/15 text-destructive",
      )}
      title={title}
    >
      {label}
    </span>
  );
}

interface StandaloneImageCardProps {
  image: StandaloneImage;
  url: string | null;
}

function StandaloneImageCard({
  image,
  url,
}: StandaloneImageCardProps): React.JSX.Element {
  const trimmed_alt = image.alt?.trim() ?? "";
  const filename = image.raw_src.split("/").pop() ?? "";
  const fallback_label = trimmed_alt || filename || "image";
  if (!url) {
    // No bytes resolved (broken ePub or external URL). Render a small
    // text marker so the curator knows something was *supposed* to be
    // here without staking out cover-sized space.
    return (
      <p className="my-1 px-1 text-center text-[11px] italic text-muted-foreground">
        [image: {fallback_label}]
      </p>
    );
  }
  // Mirror the way an e-reader lays out an illustration: no border,
  // no card, no background — just the image, centered within the
  // column. We render at the image's natural size when it fits, fall
  // back to the column width when it's wider, and cap height at the
  // viewport so a full-bleed illustration can't push every neighbour
  // off-screen. `h-auto`/`w-auto` keep the aspect ratio intact in
  // both dimensions; `object-contain` is defensive in case any
  // upstream CSS introduces a hard size.
  const caption = isMeaningfulAltText(trimmed_alt) ? trimmed_alt : null;
  return (
    <figure className="my-4 flex flex-col items-center text-center">
      <img
        src={url}
        alt={trimmed_alt || filename}
        loading="lazy"
        decoding="async"
        className="block h-auto w-auto max-h-[80vh] max-w-full object-contain"
      />
      {caption ? (
        <figcaption className="mt-1 max-w-full text-[11px] italic text-muted-foreground">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

/**
 * True iff `alt` looks like meaningful caption text rather than a
 * filename / placeholder. Most Calibre-built ePubs (Le Petit Prince
 * included) ship `alt="img17.jpg"` for every illustration; surfacing
 * that as a figcaption clutters the Reader without telling the
 * curator anything new. We treat anything that *looks like* a bare
 * filename — `imgN.ext`, `figureN.ext`, `coverN.png`, etc. — as noise.
 */
function isMeaningfulAltText(alt: string): boolean {
  if (!alt) return false;
  // A trailing image extension is a strong signal we're staring at a
  // filename. Cover the common formats; anything else falls through.
  if (/\.(jpe?g|png|gif|webp|svg|avif|bmp|tiff?)$/i.test(alt)) return false;
  // Otherwise treat as caption.
  return true;
}

interface SegmentCardProps {
  row: SegmentRow;
  side: "source" | "target";
  is_current: boolean;
  is_translating: boolean;
  image_resolver: (raw_src: string) => string | null | undefined;
  onClick(): void;
}

function SegmentCard({
  row,
  side,
  is_current,
  is_translating,
  image_resolver,
  onClick,
}: SegmentCardProps): React.JSX.Element {
  const seg = React.useMemo<Segment>(() => rowToSegment(row), [row]);
  const text = side === "source" ? row.source_text : row.target_text ?? "";
  const body = renderPreview(text, seg.inline_skeleton, image_resolver);
  const empty = side === "target" && !row.target_text;
  return (
    <div
      data-segment-id={row.id}
      onClick={onClick}
      className={cn(
        "mb-2 cursor-pointer rounded-md border-l-4 px-3 py-2 transition-colors",
        is_current
          ? "border-primary bg-accent/40"
          : "border-transparent hover:bg-accent/20",
        is_translating && "border-warning bg-warning/10",
        row.status === SegmentStatus.FLAGGED && "text-warning",
        row.status === SegmentStatus.APPROVED && "font-medium",
      )}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">
          {STATUS_GLYPH[row.status] ?? "·"} {row.idx + 1}
        </span>
        <div className={cn("min-w-0 flex-1 leading-relaxed", empty && "italic text-muted-foreground")}>
          {is_translating ? (
            <>
              <span className="font-semibold text-warning">
                ▸ Translating…
              </span>{" "}
              {body}
            </>
          ) : empty ? (
            "(not yet translated)"
          ) : (
            body
          )}
        </div>
      </div>
    </div>
  );
}

interface EditTargetDialogProps {
  row: SegmentRow;
  onCancel(): void;
  onSave(text: string): void;
}

function EditTargetDialog({
  row,
  onCancel,
  onSave,
}: EditTargetDialogProps): React.JSX.Element {
  const [text, setText] = React.useState<string>(row.target_text ?? "");
  React.useEffect(() => {
    setText(row.target_text ?? "");
  }, [row.target_text]);

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "s") {
      ev.preventDefault();
      onSave(text);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      onCancel();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit target</DialogTitle>
          <DialogDescription>
            Keep the <code>[[T0]]…[[/T0]]</code> placeholders intact —
            mismatched placeholders are flagged on save.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Source
            </div>
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2 text-sm">
              {row.source_text}
            </pre>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Target
            </div>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              rows={10}
              autoFocus
              className="font-mono text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={() => onSave(text)}>
            Save (Ctrl+S)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ChapterNotesButtonProps {
  project_id: string;
  chapter_id: string;
  has_notes: boolean;
}

/**
 * Button + dialog for editing the curator-authored chapter notes that
 * the translator prompt picks up.
 *
 * The dialog reads the current notes off the live chapter row whenever
 * it opens (so concurrent edits — e.g. from a different tab — show up
 * fresh), and writes back through `updateChapterNotes`. The translator
 * cache key already mixes in the notes, so saving a change effectively
 * invalidates the previous translations of the chapter on next retry.
 */
function ChapterNotesButton({
  project_id,
  chapter_id,
  has_notes,
}: ChapterNotesButtonProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const row = await openProjectDb(project_id).chapters.get(chapter_id);
      if (cancelled) return;
      setDraft(row?.notes ?? "");
    })();
    return () => {
      cancelled = true;
    };
  }, [open, project_id, chapter_id]);

  const onSave = async (): Promise<void> => {
    setSaving(true);
    try {
      await updateChapterNotes(project_id, chapter_id, draft);
      toast.success(
        draft.trim() ? "Chapter notes saved." : "Chapter notes cleared.",
      );
      setOpen(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not save: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant={has_notes ? "secondary" : "ghost"}
        className="gap-1.5"
        onClick={() => setOpen(true)}
        title={
          has_notes
            ? "Edit chapter notes (visible to the translator LLM)"
            : "Add chapter notes — context to give the translator about this chapter"
        }
      >
        <Pencil className="size-3.5" />
        {has_notes ? "Notes" : "Add notes"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Chapter notes</DialogTitle>
            <DialogDescription>
              Optional context for the translator LLM. Pass POV switches,
              recurring imagery, character voices, or any scene-level
              guidance that the model can&apos;t infer from the segment
              alone. Notes are stored locally and folded into the
              translator prompt for every segment in this chapter.
              Editing notes invalidates the cache for affected segments.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            placeholder={
              "e.g. Chapter is told from Sora's POV. Use her informal register.\nAll mentions of \"the manor\" refer to House Karazov, not the noble district."
            }
            className="text-sm"
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void onSave()}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save notes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function truncateForToast(s: string, max = 100): string {
  const flat = s.replace(/\n/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}\u2026`;
}

async function readProjectOverrides(
  projectId: string,
): Promise<ProjectLlmOverrides | null> {
  if (!projectId) return null;
  const db = openProjectDb(projectId);
  const row = await db.projects.get(projectId);
  if (!row?.llm_overrides) return null;
  try {
    return JSON.parse(row.llm_overrides) as ProjectLlmOverrides;
  } catch {
    return null;
  }
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
