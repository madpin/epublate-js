#!/usr/bin/env node
/**
 * Screenshot capture script for epublate.
 *
 * Walks the running dev server (defaults to http://localhost:5173) in
 * mock mode (`?mock=1`) and saves a PNG for each documented screen
 * into `docs/screenshots/`. Designed to be deterministic so re-running
 * produces stable images.
 *
 * Usage:
 *   node tools/snap.mjs
 *   BASE_URL=http://localhost:5173 OUT_DIR=docs/screenshots node tools/snap.mjs
 */

import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:5173";
const OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR ?? "docs/screenshots");
const EPUB_PATH = path.resolve(ROOT, "docs/petitprince.epub");
const VIEWPORT = { width: 1440, height: 900 };

const log = (...args) => console.log("[snap]", ...args);

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function clearDexie(page) {
  // Wipe all IndexedDB databases on the origin so each run starts
  // from a clean slate.
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases?.();
    if (Array.isArray(dbs)) {
      for (const { name } of dbs) {
        if (name) {
          await new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          });
        }
      }
    }
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });
}

/** Hide any sonner toast / status-bar overlays from screenshots. */
async function dismissOverlays(page) {
  await page
    .evaluate(() => {
      // sonner toasts are appended to a portal at the bottom-right.
      for (const el of document.querySelectorAll("[data-sonner-toaster]")) {
        if (el instanceof HTMLElement) el.style.visibility = "hidden";
      }
    })
    .catch(() => {});
}

/** Stamp the saved PNG into docs/screenshots/. */
async function snap(page, name, options = {}) {
  await ensureDir(OUT_DIR);
  const file = path.join(OUT_DIR, `${name}.png`);
  // Settle: wait for any spinner to vanish + animations to finish.
  await page.waitForLoadState("networkidle").catch(() => {});
  if (options.dismissOverlays !== false) await dismissOverlays(page);
  await page.waitForTimeout(options.settle ?? 250);
  await page.screenshot({ path: file, fullPage: false });
  log(`saved ${path.relative(ROOT, file)}`);
}

async function gotoMock(page, route = "/") {
  const url = `${BASE_URL}${route}${route.includes("?") ? "&" : "?"}mock=1`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

async function fillNewProjectForm(page) {
  // Inside the modal: pick the epub-accepting <input>.
  const epubInput = page
    .getByRole("dialog")
    .locator('input[type="file"][accept*="epub"]');
  await epubInput.first().setInputFiles(EPUB_PATH);

  // Wait until file metadata renders inside the dropzone.
  await page
    .getByRole("dialog")
    .locator('text=petitprince')
    .first()
    .waitFor({ timeout: 10_000 });

  await page.locator('#np-src').fill("fr");
  await page.locator('#np-tgt').fill("en");

  // Move focus out of the language pickers' autocomplete dropdown
  // (it intercepts pointer events otherwise) by clicking the name
  // field. We avoid pressing Escape — Radix Dialog uses it as a
  // close shortcut and would dismiss the modal entirely.
  await page.locator("#np-name").click({ force: true });
  await page.locator("#np-name").fill("Le Petit Prince");
  await page.waitForTimeout(200);

  // Keep best-effort book intake ON so the Glossary / Intake-runs /
  // LLM-activity screens actually have data to display. Tone sniff
  // is left off — three blocking helper calls during the demo aren't
  // worth the extra seconds since we capture the LLM tab regardless.
  const sniffCheckbox = page.locator('#np-tone-sniff');
  if (await sniffCheckbox.isChecked()) {
    await sniffCheckbox.click({ force: true });
  }
}

async function runBatch(page) {
  log("Running translate batch");
  await page.getByRole("button", { name: /Translate batch/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("heading", { name: /Translate batch/ })
    .waitFor();
  // Click the launch button on the modal — the batch modal usually
  // has a "Run batch" or "Translate" CTA.
  const startButton = page
    .getByRole("dialog")
    .getByRole("button", { name: /^(Run|Translate|Start)/ });
  await startButton.first().click();
  // Wait for batch status bar to disappear or status to read finished.
  await page.waitForFunction(
    () => {
      const txt = document.body.innerText;
      return /Translated/.test(txt) && !/Translating/.test(txt);
    },
    { timeout: 120_000 },
  ).catch(() => {});
  await page.waitForTimeout(600);
}

async function captureProjectsEmpty(page) {
  log("== Projects (empty) ==");
  await gotoMock(page, "/");
  await clearDexie(page);
  await gotoMock(page, "/");
  await page
    .getByRole("heading", { name: /^Projects$/ })
    .waitFor();
  await snap(page, "01-projects-empty");
}

async function captureNewProjectModal(page) {
  log("== New project modal ==");
  await page
    .locator('header')
    .getByRole("button", { name: /^New project$/ })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("heading", { name: /^New project$/ })
    .waitFor();

  await fillNewProjectForm(page);
  await page.waitForTimeout(300);
  await snap(page, "02-new-project-modal");

  // Submit the form directly via DOM. The Create-project button can
  // sit below the viewport and Playwright can't always click it
  // reliably; submitting the form bypasses that and runs the same
  // onSubmit handler as a real click.
  await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const form = dialog?.querySelector("form");
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else if (form) {
      form.dispatchEvent(
        new Event("submit", { cancelable: true, bubbles: true }),
      );
    }
  });

  // Wait for the dashboard to render. Translation is a CardTitle
  // (rendered as a <div>), not a heading — wait for the project H1
  // and the "Translated segments" stat row instead.
  await page.locator('text=Translated segments').first().waitFor({ timeout: 60_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
}

async function captureDashboard(page) {
  log("== Dashboard ==");
  await page.waitForTimeout(400);
  await snap(page, "03-dashboard");
}

async function captureBatchModalDashboard(page) {
  log("== Batch modal (Dashboard) ==");
  await page.getByRole("button", { name: /Translate batch/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("heading", { name: /Translate batch/ })
    .waitFor();
  await snap(page, "05c-batch-modal-dashboard");

  // Start it so that the rest of the screenshots have actual data.
  const cta = page.getByRole("dialog").getByRole("button", {
    name: /^(Run|Translate|Start)/,
  });
  await cta.first().click();
  // Wait for batch to finish — the dashboard's stats card flips to
  // "Translated segments: N / N".
  await page
    .waitForFunction(
      () => {
        const txt = document.body.innerText;
        const m = txt.match(/Translated segments\s*([\d,]+)\s*\/\s*([\d,]+)/);
        if (!m) return false;
        const a = m[1].replace(/,/g, "");
        const b = m[2].replace(/,/g, "");
        return a === b && a !== "0";
      },
      { timeout: 180_000 },
    )
    .catch(() => {});
  // Give Dexie a chance to flush the final write transactions to
  // disk before we hop to other routes.
  await page.waitForTimeout(2500);
}

/** Project id captured the first time we land on a /project/<id>/* URL. */
let CACHED_PROJECT_ID = null;

async function getProjectId(page) {
  const url = new URL(page.url());
  const m = url.pathname.match(/\/project\/([^/]+)/);
  if (m) CACHED_PROJECT_ID = m[1];
  return CACHED_PROJECT_ID;
}

async function gotoDashboard(page) {
  const id = await getProjectId(page);
  await gotoMock(page, `/project/${id}`);
  await page
    .locator("text=Translated segments")
    .first()
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(400);
}

async function captureReader(page) {
  log("== Reader ==");
  await gotoDashboard(page);
  // SPA-navigate via the sidebar Reader link.
  await page.locator('a[href$="/reader"]').first().click();
  await page
    .locator('button[aria-label="Back to dashboard"]')
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);

  // Click into a meatier chapter so the panes show real prose. The
  // first few chapters of Le Petit Prince are title-page material;
  // chapter 4 in the spine is "CHAPITRE II" in the body.
  const chapterButtons = page.locator('button:has-text("CHAPITRE")');
  if ((await chapterButtons.count()) >= 3) {
    await chapterButtons.nth(2).click().catch(() => {});
    await page.waitForTimeout(1500);
  }

  await snap(page, "04-reader");

  // Capture the per-chapter Translate variant of the header.
  const translateChapter = page.getByRole("button", {
    name: /Translate chapter/,
  });
  if ((await translateChapter.count()) > 0) {
    await translateChapter.first().scrollIntoViewIfNeeded();
    await snap(page, "05a-reader-translate-chapter");
    await translateChapter.first().click().catch(() => {});
    const dlg = page.getByRole("dialog");
    if ((await dlg.count()) > 0) {
      await dlg
        .getByRole("heading", { name: /Translate chapter|Translate batch/ })
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {});
      await snap(page, "05b-translate-chapter-modal");
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

async function captureGlossary(page) {
  log("== Glossary ==");
  await gotoDashboard(page);
  await page.locator('a[href$="/glossary"]').first().click();
  await page
    .locator('input[placeholder*="Filter"]')
    .first()
    .waitFor({ timeout: 10_000 });
  await page.waitForTimeout(2000);
  await snap(page, "06-glossary");
}

async function captureInbox(page) {
  log("== Inbox ==");
  await gotoDashboard(page);
  await page.locator('a[href$="/inbox"]').first().click();
  await page
    .locator("text=Flagged segments")
    .first()
    .waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  await snap(page, "08-inbox");
}

async function captureProjectSettings(page) {
  log("== Project settings ==");
  await gotoDashboard(page);
  await page.locator('a[href$="/settings"]').nth(0).click();
  await page.waitForTimeout(1000);
  await snap(page, "09-project-settings");

  // 09b — Relevant context mode. Switch the Context-window card's
  // mode dropdown to "Relevant" so the cosine-similarity sub-control
  // becomes visible, then snap the area with the "Embeddings
  // (project override)" card scrolled into view alongside.
  log("== Project settings → Relevant context mode ==");
  // The Context window card uses a native <select id="ps-ctx-mode">.
  const ctxMode = page.locator("#ps-ctx-mode");
  if ((await ctxMode.count()) > 0) {
    try {
      await ctxMode.scrollIntoViewIfNeeded();
      await ctxMode.selectOption({ value: "relevant" });
      await page.waitForTimeout(300);
      await snap(page, "09b-relevant-context-mode");
    } catch (err) {
      log("  could not switch to relevant mode:", err.message);
    }
  } else {
    log("  context mode dropdown not found, skipping 09b");
  }
}

async function captureLoreBooks(page) {
  log("== Lore Books ==");
  await gotoMock(page, "/lore");
  await page.waitForTimeout(500);
  await snap(page, "10-lore-books");
}

async function captureSettingsLlm(page) {
  log("== Settings → LLM ==");
  await gotoMock(page, "/settings");
  await page.waitForTimeout(500);
  await snap(page, "12-settings-llm");

  // 12b — Embeddings card (introduced in the embeddings retrieval
  // layer). Scrolls the page so the card title is centered, then
  // re-snaps. Falls back gracefully if the card is collapsed.
  log("== Settings → Embeddings ==");
  const embeddingsHeading = page
    .getByRole("heading", { name: /^Embeddings$/ })
    .first();
  if ((await embeddingsHeading.count()) > 0) {
    try {
      await embeddingsHeading.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await snap(page, "12b-embeddings-card");
    } catch (err) {
      log("  could not scroll to embeddings card:", err.message);
    }
  } else {
    log("  embeddings heading not found, skipping 12b");
  }
}

async function captureIntakeRuns(page) {
  log("== Intake runs ==");
  await gotoDashboard(page);
  await page.locator('a[href$="/intake"]').first().click();
  await page
    .locator("text=Run book intake")
    .first()
    .waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  await snap(page, "13-intake-runs");
}

async function captureLlmActivity(page) {
  log("== LLM activity ==");
  const id = await getProjectId(page);
  // Navigate via the dashboard's shortcut card so the per-project
  // Dexie connection that wrote the rows is still warm. Direct page
  // reloads have an intermittent race where the live query returns
  // [] before the IDB transactions surface.
  await gotoMock(page, `/project/${id}`);
  await page.locator("text=Translated segments").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  // The LLM activity shortcut is a Card-link with the icon and text.
  await page.locator('a[href*="/llm"]').first().click();
  await page.locator("text=Audit log of every prompt").first().waitFor({ timeout: 10_000 });
  await page
    .waitForFunction(
      () => !/No LLM calls yet/.test(document.body.innerText),
      { timeout: 15_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(1000);
  await snap(page, "14-llm-activity");
}

async function captureCheatSheet(page) {
  log("== Cheat sheet ==");
  await page.keyboard.press("F1");
  await page.waitForTimeout(400);
  await snap(page, "15-cheat-sheet");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}

async function captureThemes(page) {
  log("== Theme picker ==");
  // ThemeToggle is the small Palette+name button in the sidebar
  // footer. Open the dropdown menu so the four themes render.
  const trigger = page
    .locator('aside button:has(svg.lucide-palette)')
    .first();
  if ((await trigger.count()) > 0) {
    await trigger.click().catch(() => {});
    await page
      .getByRole("menu")
      .waitFor({ timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(300);
    await snap(page, "16-themes");
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
  } else {
    log("  theme trigger not found, skipping");
  }
}

async function captureProjectsPopulated(page) {
  log("== Projects (populated) ==");
  await gotoMock(page, "/");
  await page.waitForTimeout(500);
  await snap(page, "01b-projects-populated");
}

async function captureHero(page) {
  log("== Hero (Dashboard) ==");
  // Reuse the dashboard with a translated batch.
  const id = await getProjectId(page);
  if (id) {
    await gotoMock(page, `/project/${id}`);
    await page.waitForTimeout(500);
  }
  await snap(page, "00-hero");
}

async function main() {
  log("BASE_URL", BASE_URL);
  log("OUT_DIR", OUT_DIR);
  await ensureDir(OUT_DIR);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  ctx.on("console", (msg) => {
    if (msg.type() === "error") {
      console.error("  [console.error]", msg.text());
    }
  });

  const page = await ctx.newPage();

  try {
    await captureProjectsEmpty(page);
    await captureNewProjectModal(page);
    await captureDashboard(page);
    await captureBatchModalDashboard(page);
    // After batch there's data; capture again with progress filled.
    await page.waitForTimeout(500);
    await snap(page, "03-dashboard-translated", { settle: 400 });
    await captureReader(page);
    await captureGlossary(page);
    await captureInbox(page);
    await captureProjectSettings(page);
    await captureLoreBooks(page);
    await captureSettingsLlm(page);
    await captureIntakeRuns(page);
    await captureLlmActivity(page);
    await captureCheatSheet(page);
    await captureThemes(page);
    await captureProjectsPopulated(page);
    // Use the populated dashboard as the hero.
    const id = await getProjectId(page);
    if (id) {
      await gotoMock(page, `/project/${id}`);
      await page.waitForTimeout(500);
    } else {
      // Click into the first project tile.
      const card = page.locator('a[href^="/project/"]').first();
      if ((await card.count()) > 0) await card.click();
      await page.waitForTimeout(500);
    }
    await captureHero(page);
  } catch (err) {
    console.error("[snap] failed:", err);
    process.exitCode = 1;
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main();
