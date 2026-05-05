import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeProjectDb, openProjectDb } from "@/db/dexie";
import { newId } from "@/lib/id";
import { ChapterStatus } from "@/db/schema";

import {
  createChapter,
  getChapter,
  listChapters,
  updateChapterNotes,
  updateChapterStatus,
} from "./chapters";

let project_id: string;

beforeEach(async () => {
  project_id = newId();
});

afterEach(() => {
  closeProjectDb(project_id);
});

describe("chapters repo", () => {
  it("creates and lists chapters in spine order", async () => {
    const a = await createChapter({
      project_id,
      spine_idx: 1,
      href: "ch01.xhtml",
      title: "Chapter 1",
    });
    const b = await createChapter({
      project_id,
      spine_idx: 0,
      href: "intro.xhtml",
      title: null,
    });
    const list = await listChapters(project_id);
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
  });

  it("updates the chapter status", async () => {
    const ch = await createChapter({
      project_id,
      spine_idx: 0,
      href: "ch.xhtml",
      title: null,
    });
    await updateChapterStatus(project_id, ch.id, ChapterStatus.IN_PROGRESS);
    const fresh = await getChapter(project_id, ch.id);
    expect(fresh?.status).toBe(ChapterStatus.IN_PROGRESS);
  });

  it("stores curator notes (trimmed) and clears with null/empty", async () => {
    const ch = await createChapter({
      project_id,
      spine_idx: 0,
      href: "ch.xhtml",
      title: null,
    });

    await updateChapterNotes(project_id, ch.id, "  Key plot beat. ");
    const after_set = await getChapter(project_id, ch.id);
    expect(after_set?.notes).toBe("Key plot beat.");

    await updateChapterNotes(project_id, ch.id, "");
    const after_empty = await getChapter(project_id, ch.id);
    expect(after_empty?.notes).toBeNull();

    await updateChapterNotes(project_id, ch.id, "another note");
    await updateChapterNotes(project_id, ch.id, null);
    const after_null = await getChapter(project_id, ch.id);
    expect(after_null?.notes).toBeNull();
  });

  it("does not affect the row when called with whitespace-only notes", async () => {
    const ch = await createChapter({
      project_id,
      spine_idx: 0,
      href: "ch.xhtml",
      title: null,
    });
    await updateChapterNotes(project_id, ch.id, "   \n\t   ");
    const fresh = await getChapter(project_id, ch.id);
    expect(fresh?.notes).toBeNull();
  });

  it("countPendingByChapter is verified via segments repo", () => {
    // sanity: the chapters repo doesn't own pending counts; this test
    // is here just to flag a future move.
    expect(typeof openProjectDb).toBe("function");
  });
});
