#!/usr/bin/env node
/**
 * One-shot screenshot capture for the in-app Help & Guides route.
 *
 * The full `tools/snap.mjs` pipeline imports a project, runs a
 * translation batch, and walks every screen — useful for a complete
 * docs refresh, but overkill (and slow) when you only need to
 * re-capture the standalone Help page. This script targets that one
 * route directly.
 *
 * Usage:
 *   npm run dev              # one terminal
 *   node tools/snap-help.mjs # another terminal (defaults to :5174)
 *   BASE_URL=http://localhost:5173 node tools/snap-help.mjs
 */

import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:5174";
const OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR ?? "docs/screenshots");
const VIEWPORT = { width: 1440, height: 900 };

async function snap(page, name) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page
    .evaluate(() => {
      for (const el of document.querySelectorAll("[data-sonner-toaster]")) {
        if (el instanceof HTMLElement) el.style.visibility = "hidden";
      }
    })
    .catch(() => {});
  await page.waitForTimeout(250);
  await page.screenshot({ path: file, fullPage: false });
  console.log("[snap-help] saved", path.relative(ROOT, file));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const page = await ctx.newPage();
try {
  console.log("[snap-help] BASE_URL", BASE_URL);
  await page.goto(`${BASE_URL}/help?mock=1`);
  await page.waitForLoadState("domcontentloaded");
  // Hero + Quickstart (top of the page).
  await page.waitForTimeout(900);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await snap(page, "18-help");

  // Local Ollama section — the most-needed connectivity recipe.
  const pill = page.locator('a[href="#local-llm"]').first();
  if ((await pill.count()) > 0) {
    await pill.click().catch(() => {});
  } else {
    await page
      .evaluate(() => {
        window.location.hash = "local-llm";
      })
      .catch(() => {});
  }
  await page.waitForTimeout(900);
  await snap(page, "18b-help-ollama");
} finally {
  await ctx.close();
  await browser.close();
}
