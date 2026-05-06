/**
 * Helpers for Chrome 142+ Local Network Access (LNA).
 *
 * Background:
 *
 * Chrome 142 replaced the old Private Network Access (PNA) preflight
 * machinery with a permission-prompt model. When an HTTPS page on a
 * public origin (e.g. a Vercel deploy) calls a loopback URL like
 * `http://localhost:11434`, Chrome:
 *
 * 1. Refuses the request as mixed content unless either
 *    - the hostname is a private IP literal (`192.168.x.x`,
 *      `10.x.x.x`, etc.) or a `.local` domain, in which case Chrome
 *      auto-exempts it; or
 *    - the `fetch()` call is annotated with the option
 *      `targetAddressSpace: "local" | "loopback"`.
 * 2. Even after the mixed-content carve-out, prompts the user once
 *    for the LNA permission. Granting it persists for the origin.
 *
 * The string `"localhost"` is *not* covered by Chrome's automatic
 * carve-out (it's a hostname that resolves to loopback, not a literal),
 * so we have to opt in explicitly for it. This module classifies a URL
 * into the right `targetAddressSpace` value (or `null` if the URL is a
 * normal public endpoint).
 *
 * The fetch option `targetAddressSpace` is currently Chrome-specific
 * and not in the standard `RequestInit` typings; the call sites cast
 * the request init through `LnaFetchInit`.
 *
 * Spec: https://wicg.github.io/local-network-access
 * Doc:  https://developer.chrome.com/blog/local-network-access
 */

export type TargetAddressSpace = "loopback" | "local" | "public";

/**
 * Tiny extension of `RequestInit` that includes Chrome's
 * `targetAddressSpace` option. Browsers that don't recognise the field
 * silently ignore it, so this is safe to spread into any fetch call.
 */
export interface LnaFetchInit extends RequestInit {
  targetAddressSpace?: TargetAddressSpace;
}

/**
 * Classify a URL into the address space Chrome's LNA layer uses.
 *
 * - `"loopback"` for the IPv4 loopback prefix (`127.0.0.0/8`), the
 *   IPv6 loopback (`::1`), and the literal hostname `"localhost"`.
 *   Chrome's mixed-content auto-carve-out *doesn't* cover the bare
 *   string `"localhost"`, so we always need to annotate it.
 * - `"local"` for RFC1918 (`10/8`, `172.16/12`, `192.168/16`),
 *   IPv4 link-local (`169.254/16`), IPv6 ULA (`fc00::/7`), and IPv6
 *   link-local (`fe80::/10`). Plus `.local` mDNS hostnames.
 * - `null` for everything else (public endpoints — no annotation).
 *
 * Returns `null` rather than `"public"` so callers can treat it as a
 * "should we set the option?" predicate. Setting `"public"` on a
 * regular cloud endpoint is harmless but pointless.
 */
export function targetAddressSpaceFor(url: string): TargetAddressSpace | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  // URL parser keeps IPv6 literal brackets; drop them so the regex
  // checks below can compare on the bare address.
  const bare =
    host.startsWith("[") && host.endsWith("]")
      ? host.slice(1, -1).toLowerCase()
      : host.toLowerCase();

  if (
    bare === "localhost" ||
    bare === "127.0.0.1" ||
    bare === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(bare)
  ) {
    return "loopback";
  }

  if (bare.endsWith(".local")) return "local";
  if (/^10(?:\.\d{1,3}){3}$/.test(bare)) return "local";
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(bare)) return "local";
  if (/^172\.(1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(bare)) return "local";
  if (/^169\.254(?:\.\d{1,3}){2}$/.test(bare)) return "local";
  if (/^fe[89ab][0-9a-f]?:/.test(bare)) return "local"; // fe80::/10
  if (/^fc[0-9a-f]{2}:/.test(bare) || /^fd[0-9a-f]{2}:/.test(bare)) {
    return "local"; // fc00::/7
  }

  return null;
}

/**
 * Convenience: spread the right LNA fields into a fetch init when the
 * URL targets a private network. Returns the init unchanged for
 * public URLs so the caller doesn't have to special-case anything.
 */
export function withLnaInit(
  init: LnaFetchInit,
  url: string,
): LnaFetchInit {
  const space = targetAddressSpaceFor(url);
  if (space === null) return init;
  return { ...init, targetAddressSpace: space };
}
