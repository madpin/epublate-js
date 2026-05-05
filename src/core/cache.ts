/**
 * DB-backed LLM call cache (mirrors `epublate.core.cache`).
 *
 * Cache key:
 *
 *     sha256(model : system_hash : user_hash : glossary_hash)
 *
 * The Python tool uses blake2b — we use SHA-256 here because
 * `crypto.subtle.digest` ships in every browser without the WebCrypto
 * polyfill rabbit hole. The hash never crosses tool boundaries (it's
 * only used as an index key inside the user's own browser), so
 * "different hash family" is a non-issue.
 *
 * The `cache_key` lives on the `llm_calls` row; cache hits set
 * `cache_hit = 1`, `cost_usd = 0`, and re-insert a fresh row so the
 * audit trail keeps a clean breadcrumb (mirrors PRD F-LLM-6).
 */

import { sha256Hex } from "@/lib/hash";
import type { Message } from "@/llm/base";

export const EMPTY_GLOSSARY_HASH = "0".repeat(32);

export async function hashMessages(
  messages: readonly Message[],
): Promise<{ system_hash: string; user_hash: string }> {
  const system_parts: string[] = [];
  const user_parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      system_parts.push(msg.content);
    } else {
      user_parts.push(`${msg.role}\u0000${msg.content}`);
    }
  }
  const [system_hash, user_hash] = await Promise.all([
    sha256Hex(system_parts.join("\u0001")),
    sha256Hex(user_parts.join("\u0001")),
  ]);
  return { system_hash, user_hash };
}

export async function cacheKey(input: {
  model: string;
  system_hash: string;
  user_hash: string;
  glossary_hash?: string;
}): Promise<string> {
  const glossary_hash = input.glossary_hash ?? EMPTY_GLOSSARY_HASH;
  const blob = [input.model, input.system_hash, input.user_hash, glossary_hash].join(
    ":",
  );
  return sha256Hex(blob);
}

export async function cacheKeyForMessages(input: {
  model: string;
  messages: readonly Message[];
  glossary_hash?: string;
}): Promise<string> {
  const { system_hash, user_hash } = await hashMessages(input.messages);
  return cacheKey({
    model: input.model,
    system_hash,
    user_hash,
    glossary_hash: input.glossary_hash,
  });
}
