import { describe, expect, it } from "vitest";

import { formatCost, formatTokens, formatTokensCompact } from "./numbers";

describe("formatTokens", () => {
  it("returns plain integers for typical token counts", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(123)).toBe("123");
    expect(formatTokens(1234)).toBe("1,234");
    expect(formatTokens(123_456)).toBe("123,456");
    expect(formatTokens(1_500_000)).toBe("1,500,000");
  });

  it("never produces scientific notation, even for huge counts", () => {
    expect(formatTokens(1e21)).not.toMatch(/e/i);
    expect(formatTokens(1e21)).toMatch(/^[\d,]+$/);
  });

  it("rounds floats to integers (some proxies emit floats)", () => {
    expect(formatTokens(123.6)).toBe("124");
  });

  it("treats null/undefined/non-finite as zero", () => {
    expect(formatTokens(null)).toBe("0");
    expect(formatTokens(undefined)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("formatTokensCompact", () => {
  it("uses comma form below 10K", () => {
    expect(formatTokensCompact(0)).toBe("0");
    expect(formatTokensCompact(9_999)).toBe("9,999");
  });

  it("switches to K above 10K", () => {
    expect(formatTokensCompact(12_345)).toBe("12.3K");
    expect(formatTokensCompact(999_999)).toBe("1000.0K");
  });

  it("switches to M at 1M", () => {
    expect(formatTokensCompact(1_500_000)).toBe("1.50M");
    expect(formatTokensCompact(2_345_678)).toBe("2.35M");
  });
});

describe("formatCost", () => {
  it("uses 4 decimals by default for normal spend", () => {
    expect(formatCost(0)).toBe("$0.0000");
    expect(formatCost(0.0034)).toBe("$0.0034");
    expect(formatCost(1.2345)).toBe("$1.2345");
    expect(formatCost(123.456789)).toBe("$123.4568");
  });

  it("widens precision so a sub-cent spend is not rounded to zero", () => {
    expect(formatCost(0.0000034)).toBe("$0.0000034");
    expect(formatCost(0.00000125)).toBe("$0.0000013");
  });

  it("formats negatives with a leading sign before the dollar", () => {
    expect(formatCost(-1.23)).toBe("-$1.2300");
  });

  it("respects the decimals option", () => {
    expect(formatCost(0.123456, { decimals: 6 })).toBe("$0.123456");
  });

  it("treats null/undefined as zero with the requested precision", () => {
    expect(formatCost(null)).toBe("$0.0000");
    expect(formatCost(undefined, { decimals: 2 })).toBe("$0.00");
  });
});
