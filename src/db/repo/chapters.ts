/**
 * Chapter-row CRUD (mirrors `epublate.db.repo.chapter`).
 *
 * A chapter is the persistent twin of a `ChapterDoc` from
 * `formats/epub/types.ts`. The DOM tree itself is *not* stored — we
 * always re-parse the source ePub on open. This keeps the project DB
 * small (a 50 MB book of XHTML is < 5 MB of segments + glossary)
 * and side-steps the cost of re-serializing every tree mutation.
 */

import { newId } from "@/lib/id";

import { openProjectDb } from "../dexie";
import {
  type ChapterRow,
  type ChapterStatusT,
  ChapterStatus,
} from "../schema";

export interface CreateChapterInput {
  project_id: string;
  spine_idx: number;
  href: string;
  title: string | null;
  status?: ChapterStatusT;
}

export async function createChapter(input: CreateChapterInput): Promise<ChapterRow> {
  const row: ChapterRow = {
    id: newId(),
    project_id: input.project_id,
    spine_idx: input.spine_idx,
    href: input.href,
    title: input.title,
    status: input.status ?? ChapterStatus.PENDING,
  };
  const db = openProjectDb(input.project_id);
  await db.chapters.put(row);
  return row;
}

export async function listChapters(projectId: string): Promise<ChapterRow[]> {
  const db = openProjectDb(projectId);
  return db.chapters.where("project_id").equals(projectId).sortBy("spine_idx");
}

export async function getChapter(
  projectId: string,
  chapterId: string,
): Promise<ChapterRow | undefined> {
  const db = openProjectDb(projectId);
  return db.chapters.get(chapterId);
}

export async function updateChapterStatus(
  projectId: string,
  chapterId: string,
  status: ChapterStatusT,
): Promise<void> {
  const db = openProjectDb(projectId);
  await db.chapters.update(chapterId, { status });
}

/**
 * Persist a curator-authored note on the chapter.
 *
 * `null` (or empty after trim) clears any previously-stored note. We
 * normalise on the way in so the prompt builder doesn't have to worry
 * about whitespace-only payloads.
 */
export async function updateChapterNotes(
  projectId: string,
  chapterId: string,
  notes: string | null,
): Promise<void> {
  const db = openProjectDb(projectId);
  const cleaned = notes?.trim();
  await db.chapters.update(chapterId, {
    notes: cleaned ? cleaned : null,
  });
}
