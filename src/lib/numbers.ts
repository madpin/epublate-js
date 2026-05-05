/**
 * Centralised number formatters for the UI.
 *
 * - `formatTokens` — token counts as plain integers ("1,234,567") or
 *   compact units ("1.2M") when grouped. Crucially, it never emits
 *   scientific notation: `String(1e21)` is `"1e+21"`, but a curator
 *   reading the cost meter wants `"1,000,000,000,000,000,000,000"` or
 *   the compact form. The literary-translation workflow does generate
 *   millions of tokens fast, so the compact form is the default for
 *   meter labels; raw integers are kept for log rows where the
 *   exact count matters.
 * - `formatCost` — USD costs with adaptive precision: 4 decimals for
 *   "normal" spend ($0.0034), more decimals for tiny costs so the
 *   meter doesn't round a real charge down to "$0.0000".
 *
 * Mirrors `epublate.app.widgets.cost_meter._fmt_tokens` (and the
 * Python project's `:.4f` for cost), with one extension: when the
 * cost is small enough that 4 decimals would print "0.0000" but the
 * actual value is non-zero, we widen the precision so the curator
 * can tell a free model from a sub-cent spend.
 */

const TOKEN_INT_FMT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const COMPACT_FMT_K = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  useGrouping: false,
});

const COMPACT_FMT_M = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
});

/**
 * Plain integer token count with thousand separators
 * (`1234567` → `"1,234,567"`).
 *
 * Never produces scientific notation, even for ridiculously large
 * counts — `Intl.NumberFormat` always emits decimal digits.
 */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "0";
  if (n < 0) return `-${formatTokens(-n)}`;
  return TOKEN_INT_FMT.format(Math.round(n));
}

/**
 * Compact token count for tight meter layouts (`1234` → `"1,234"`,
 * `12345` → `"12.3K"`, `1500000` → `"1.50M"`).
 *
 * Mirrors :func:`epublate.app.widgets.cost_meter._fmt_tokens`.
 */
export function formatTokensCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "0";
  if (n < 0) return `-${formatTokensCompact(-n)}`;
  if (n < 10_000) return TOKEN_INT_FMT.format(Math.round(n));
  if (n < 1_000_000) return `${COMPACT_FMT_K.format(n / 1_000)}K`;
  if (n < 1_000_000_000) return `${COMPACT_FMT_M.format(n / 1_000_000)}M`;
  return `${COMPACT_FMT_M.format(n / 1_000_000_000)}B`;
}

export interface FormatCostOptions {
  /** Always include the leading `$`. Defaults to `true`. */
  withSign?: boolean;
  /**
   * Default decimals when the cost is comfortably above zero
   * (`>= 0.0001`). Defaults to 4 to match the Python tool.
   */
  decimals?: number;
}

/**
 * USD cost with adaptive precision so a real-but-tiny spend doesn't
 * round to `$0.0000`. The Python tool uses a flat `:.4f`; we keep
 * that for the common range and widen the decimal count when needed
 * so curators don't see "$0.0000" for a sub-cent translation.
 */
export function formatCost(
  usd: number | null | undefined,
  options: FormatCostOptions = {},
): string {
  const { withSign = true, decimals = 4 } = options;
  const prefix = withSign ? "$" : "";
  if (usd === null || usd === undefined || !Number.isFinite(usd)) {
    return `${prefix}0.${"0".repeat(decimals)}`;
  }
  const sign = usd < 0 ? "-" : "";
  const abs = Math.abs(usd);
  if (abs === 0) {
    return `${sign}${prefix}0.${"0".repeat(decimals)}`;
  }
  // If the default precision would print "0.0000" but the value is
  // non-zero, widen precision until we display at least one sig digit.
  const rounded = Number(abs.toFixed(decimals));
  if (rounded === 0) {
    // Compute decimals needed for the leading non-zero digit.
    // For abs ∈ [10^k, 10^(k+1)), we need (-k) decimals to place the
    // first significant digit; +1 keeps an extra digit so a $0.0000034
    // shows as "$0.0000034" rather than rounding to "$0.000003".
    const log = Math.floor(Math.log10(abs));
    const widened = Math.min(12, Math.max(decimals + 1, -log + 1));
    return `${sign}${prefix}${abs.toFixed(widened)}`;
  }
  return `${sign}${prefix}${abs.toFixed(decimals)}`;
}
