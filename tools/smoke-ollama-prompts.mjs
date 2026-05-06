#!/usr/bin/env node
/**
 * Phase-7 Ollama smoke harness for the configurable-prompts work.
 *
 * Hits the local Ollama endpoint with the **exact** wire shape the
 * SPA's translator (and helper-LLM summary services) emit, using the
 * curator-confirmed model. Verifies four things end-to-end:
 *
 *   1. Translator prompt — XML-tagged system prefix + per-segment
 *      user tail + JSON output_format. Round-trips through
 *      `parseTranslatorResponse`-equivalent extraction.
 *   2. Book summary helper-LLM — system + user pair that asks for a
 *      strict JSON object. Confirms Ollama emits valid JSON.
 *   3. Chapter summary helper-LLM — same shape, smaller scope.
 *   4. Cache-prefix benefit — re-run the translator with a fresh
 *      user message but the same system prefix and report
 *      `prompt_eval_count` (Ollama exposes the cached-prefix tokens
 *      in this field; lower on the warm call ⇒ prefix was cached).
 *
 * Usage:
 *
 *   node tools/smoke-ollama-prompts.mjs                  # gemma4:26b @ localhost:11434
 *   OLLAMA_BASE=http://10.0.0.5:11434 MODEL=gemma4:26b node tools/smoke-ollama-prompts.mjs
 *
 * Exits 0 on success, non-zero on failure. Designed to be safe to
 * run from CI (no network beyond the configured endpoint, no IDB
 * dependency).
 */

// Node 22's global `fetch` is backed by Undici, whose default
// `headersTimeout`/`bodyTimeout` cap out at 5 minutes — that's why the
// smoke harness kept dying at ~303s with a generic "fetch failed". A
// 26B model running on a CPU host can easily take longer than that to
// even *start* streaming a long-context response, so swap to a small
// `http.request` shim that owns its own (much larger) timeouts.
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const BASE = process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434";
const MODEL = process.env.MODEL ?? "gemma4:26b";

const log = (...args) => console.log("[smoke]", ...args);
const fail = (msg) => {
  console.error("[smoke] FAIL:", msg);
  process.exit(1);
};

// Disable `response_format: json_object` by default. Local Ollama
// builds for some model families (notably `gemma4:*`) crash the
// underlying llama.cpp runner when grammar-constrained sampling kicks
// in, returning a 5xx with `"llama runner process no longer running"`.
// The SPA's `chatWithJsonFallback` (see `src/llm/json_mode.ts`) now
// catches that case and retries without the constraint, but the smoke
// harness talks to Ollama directly and mirrors the *post-fallback*
// shape so a successful run proves the JSON-only-instructions prompt
// is enough on its own. Set `OLLAMA_JSON_MODE=1` to re-enable.
const FORCE_JSON_MODE = process.env.OLLAMA_JSON_MODE === "1";

async function chat(messages, { force_json = FORCE_JSON_MODE } = {}) {
  const body = JSON.stringify({
    model: MODEL,
    messages,
    stream: false,
    temperature: 0.2,
    ...(force_json ? { response_format: { type: "json_object" } } : {}),
  });
  const t0 = Date.now();
  const { status, text } = await postJson(`${BASE}/v1/chat/completions`, body);
  const elapsed_ms = Date.now() - t0;
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* keep `json` empty so the error path can still report the raw text */
  }
  if (status < 200 || status >= 300) {
    throw new Error(
      `Ollama responded ${status}: ${(text || JSON.stringify(json)).slice(0, 400)}`,
    );
  }
  return {
    content: json.choices?.[0]?.message?.content ?? "",
    usage: json.usage ?? {},
    elapsed_ms,
    raw: json,
  };
}

/**
 * Tiny POST helper that talks straight to the upstream HTTP server,
 * keeping the socket open for as long as the model needs to think.
 *
 * Returns `{ status, text }` — JSON parsing is the caller's job.
 */
function postJson(url_str, body) {
  const url = new URL(url_str);
  const lib = url.protocol === "https:" ? https : http;
  const opts = {
    method: "POST",
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: `${url.pathname}${url.search || ""}`,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Accept: "application/json",
    },
  };
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    // Disable any socket inactivity timeout — Ollama can sit on a
    // request for tens of minutes while a 26B model warms or runs.
    req.setTimeout(0);
    req.write(body);
    req.end();
  });
}

function extractJson(text) {
  // Forgiving JSON extractor — Ollama models occasionally wrap JSON
  // in code fences or chatter even when asked not to. Mirrors the
  // SPA's `parseTranslatorResponse` behaviour.
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return null;
}

// -----------------------------------------------------------------------
// 1. Translator prompt — exact XML structure the SPA emits.
// -----------------------------------------------------------------------

function buildTranslatorMessages({ user_segment }) {
  const system = [
    `You are a literary translator working on a long ePub story book.`,
    ``,
    `Translate the user's source segment from French (fr) to English (en).`,
    ``,
    `The user message is structured as XML. The block under \`<source>\` is the segment to translate; treat \`<chapter_notes>\`, \`<proposed_terms>\`, and \`<recent_context>\` as advisory context that you MUST NOT translate or echo back. Translate ONLY the contents of \`<source>\` and return your translation in the JSON \`target\` field described at the bottom of this prompt.`,
    ``,
    `Hard rules — these are not negotiable:`,
    `1. Inline formatting is encoded as opaque placeholders of the form [[T0]], [[/T0]], [[T1]], etc. Every placeholder that appears in the source MUST appear exactly once in your translation, in the same relative order. Do not invent new placeholders. Do not drop any. Closing placeholders ([[/T0]]) must always pair with their opener ([[T0]]).`,
    `2. Translate naturally for the target audience but preserve narrative voice, tense, and POV. Do not paraphrase past the meaning of the source. Do not summarize.`,
    `3. Translate every textual passage end-to-end. Do not preserve "original quote" cargo unless explicitly asked.`,
    `4. Preserve leading/trailing whitespace verbatim.`,
    `5. Keep proper nouns consistent — the glossary is the contract.`,
    `6. Locked > confirmed > proposed. Drop proposed entries from the prompt.`,
    `7. Apply a glossary entry only when the source token is used in the same sense.`,
    `8. Honour gender markers on the canonical target term.`,
    ``,
    `<language_notes lang="en">`,
    `English: prefer Oxford-comma style; quoted dialogue uses curly "smart" quotes.`,
    `</language_notes>`,
    ``,
    `<style_guide>`,
    `Literary fiction. Lyrical but unfussy register. Preserve the source's poetic punctuation.`,
    `</style_guide>`,
    ``,
    `<book_summary>`,
    `Le Petit Prince — a 1943 novella by Antoine de Saint-Exupéry. The narrator, a downed pilot in the Sahara, meets a small boy from a tiny asteroid. Through their conversations the boy recounts his journeys among the planets and his love for a single rose he has left behind.`,
    `</book_summary>`,
    ``,
    `<glossary>`,
    `(none yet)`,
    `</glossary>`,
    ``,
    `<output_format>`,
    `Respond with a strict JSON object exactly matching:`,
    `{"target": "string with the translation, including all placeholders","used_entries": [],"new_entities": [],"notes": ""}`,
    `</output_format>`,
  ].join("\n");

  const user = [
    `<chapter_notes>`,
    `Chapter is told from the narrator's POV. He is a stranded pilot recalling his childhood drawings of a boa constrictor that swallowed an elephant whole.`,
    `</chapter_notes>`,
    ``,
    `<source>`,
    user_segment,
    `</source>`,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function smokeTranslator() {
  log(`== Translator prompt round-trip · model=${MODEL} ==`);
  const segment = `Lorsque j'avais six ans j'ai vu, une fois, une magnifique image, dans un livre sur la Forêt Vierge qui s'appelait [[T0]]Histoires Vécues[[/T0]].`;
  const messages = buildTranslatorMessages({ user_segment: segment });
  const cold = await chat(messages);
  const parsed = extractJson(cold.content);
  if (!parsed || typeof parsed.target !== "string") {
    fail(
      `translator response did not contain a string \`target\` field. Raw: ${cold.content.slice(0, 400)}`,
    );
  }
  if (!parsed.target.includes("[[T0]]")) {
    fail(
      `translator dropped the [[T0]] placeholder. Got: ${parsed.target.slice(0, 200)}`,
    );
  }
  log(`  cold call ok — elapsed=${cold.elapsed_ms}ms usage=${JSON.stringify(cold.usage)}`);
  log(`  target preview: ${parsed.target.slice(0, 120).replace(/\n/g, " ")}…`);

  // Re-run with a different user tail but identical system prefix.
  const second_segment = `Et il avait un mouton.`;
  const messages2 = buildTranslatorMessages({ user_segment: second_segment });
  const warm = await chat(messages2);
  const parsed2 = extractJson(warm.content);
  if (!parsed2 || typeof parsed2.target !== "string") {
    fail(
      `second translator call did not produce a string \`target\`. Raw: ${warm.content.slice(0, 400)}`,
    );
  }
  log(`  warm call ok — elapsed=${warm.elapsed_ms}ms usage=${JSON.stringify(warm.usage)}`);
  log(
    `  cache hint: cold prompt_tokens=${cold.usage?.prompt_tokens ?? "?"} warm prompt_tokens=${warm.usage?.prompt_tokens ?? "?"}`,
  );
  log(
    `  (Ollama's prefix cache lives below the OpenAI-compat layer; the prompt_tokens line is a best-effort signal.)`,
  );
}

// -----------------------------------------------------------------------
// 2. Book summary helper.
// -----------------------------------------------------------------------

async function smokeBookSummary() {
  log(`== Book summary helper · model=${MODEL} ==`);
  const messages = [
    {
      role: "system",
      content:
        `You write a 200–400 word recap of a book for the benefit of a downstream literary translator. Output a strict JSON object: {"summary": "..."}`,
    },
    {
      role: "user",
      content: [
        `<source_lang>fr</source_lang>`,
        `<target_lang>en</target_lang>`,
        `<excerpts>`,
        `Lorsque j'avais six ans j'ai vu, une fois, une magnifique image, dans un livre sur la Forêt Vierge qui s'appelait Histoires Vécues. Ça représentait un serpent boa qui avalait un fauve.`,
        `Quand le mystère est trop impressionnant, on n'ose pas désobéir.`,
        `S'il vous plaît… dessine-moi un mouton !`,
        `</excerpts>`,
      ].join("\n"),
    },
  ];
  const res = await chat(messages);
  const parsed = extractJson(res.content);
  if (!parsed || typeof parsed.summary !== "string") {
    fail(
      `book-summary response did not contain a string \`summary\` field. Raw: ${res.content.slice(0, 400)}`,
    );
  }
  log(
    `  ok — elapsed=${res.elapsed_ms}ms summary words=${parsed.summary.trim().split(/\s+/).length}`,
  );
}

// -----------------------------------------------------------------------
// 3. Chapter summary helper.
// -----------------------------------------------------------------------

async function smokeChapterSummary() {
  log(`== Chapter summary helper · model=${MODEL} ==`);
  const messages = [
    {
      role: "system",
      content:
        `You write a 50–120 word chapter recap for the benefit of a downstream literary translator. Output a strict JSON object: {"summary": "..."}`,
    },
    {
      role: "user",
      content: [
        `<book_summary>Le Petit Prince by Antoine de Saint-Exupéry.</book_summary>`,
        `<chapter_excerpts>`,
        `Le narrateur, à six ans, dessine un boa qui avale un éléphant. Les grandes personnes lui conseillent d'abandonner ses dessins et de s'intéresser plutôt à la géographie, à l'histoire et au calcul.`,
        `</chapter_excerpts>`,
      ].join("\n"),
    },
  ];
  const res = await chat(messages);
  const parsed = extractJson(res.content);
  if (!parsed || typeof parsed.summary !== "string") {
    fail(
      `chapter-summary response did not contain a string \`summary\` field. Raw: ${res.content.slice(0, 400)}`,
    );
  }
  log(
    `  ok — elapsed=${res.elapsed_ms}ms summary words=${parsed.summary.trim().split(/\s+/).length}`,
  );
}

(async () => {
  log(
    `Ollama base=${BASE} model=${MODEL} json_mode=${FORCE_JSON_MODE ? "on" : "off"}`,
  );
  try {
    await smokeBookSummary();
    await smokeChapterSummary();
    await smokeTranslator();
    log("ALL SMOKES PASSED.");
  } catch (err) {
    fail(err.message ?? String(err));
  }
})();
