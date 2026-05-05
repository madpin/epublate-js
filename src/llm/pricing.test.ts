import { afterEach, describe, expect, it } from "vitest";

import {
  applyPricingOverrides,
  estimateCost,
  getPrice,
  hasPrice,
  listEffectivePricing,
  listPricingOverrides,
  resetPrices,
  setPrice,
} from "./pricing";

afterEach(() => {
  resetPrices();
});

describe("getPrice", () => {
  it("returns the exact price when registered", () => {
    expect(getPrice("gpt-4o")).toEqual({
      input_per_mtok: 2.5,
      output_per_mtok: 10.0,
    });
  });

  it("strips the OpenAI -YYYY-MM-DD date suffix", () => {
    expect(getPrice("gpt-4o-2024-08-06")).toEqual({
      input_per_mtok: 2.5,
      output_per_mtok: 10.0,
    });
  });

  it("walks back over hyphen boundaries to the longest known prefix", () => {
    expect(getPrice("gpt-4o-mini-2024-07-18")).toEqual({
      input_per_mtok: 0.15,
      output_per_mtok: 0.6,
    });
  });

  it("returns zero for unknown free / OSS models", () => {
    expect(getPrice("llama3:70b")).toEqual({
      input_per_mtok: 0,
      output_per_mtok: 0,
    });
  });

  it("includes deepseek/claude/gemini in defaults", () => {
    expect(hasPrice("deepseek-chat")).toBe(true);
    expect(hasPrice("claude-sonnet-4")).toBe(true);
    expect(hasPrice("gemini-2.0-flash")).toBe(true);
  });
});

describe("estimateCost", () => {
  it("computes input + output cost using USD per million tokens", () => {
    // gpt-4o: 2.5 / 10.0
    const cost = estimateCost("gpt-4o", 1_000_000, 200_000);
    // 1M input × $2.50 + 0.2M output × $10.00 = 2.50 + 2.00 = 4.50
    expect(cost).toBeCloseTo(4.5, 6);
  });

  it("returns zero for unpriced models without throwing", () => {
    expect(estimateCost("zzz-unknown-model", 5_000, 5_000)).toBe(0);
  });

  it("rejects negative token counts", () => {
    expect(() => estimateCost("gpt-4o", -1, 0)).toThrow();
    expect(() => estimateCost("gpt-4o", 0, -1)).toThrow();
  });
});

describe("user pricing overrides", () => {
  it("layers overrides on top of defaults via applyPricingOverrides", () => {
    applyPricingOverrides({
      "deepseek-v4-flash": { input_per_mtok: 0.10, output_per_mtok: 0.40 },
    });
    expect(getPrice("deepseek-v4-flash")).toEqual({
      input_per_mtok: 0.10,
      output_per_mtok: 0.40,
    });
    // defaults still resolve.
    expect(hasPrice("gpt-4o")).toBe(true);
  });

  it("listPricingOverrides only returns user-defined rows", () => {
    applyPricingOverrides({
      "deepseek-v4-flash": { input_per_mtok: 0.10, output_per_mtok: 0.40 },
    });
    expect(listPricingOverrides()).toEqual({
      "deepseek-v4-flash": { input_per_mtok: 0.10, output_per_mtok: 0.40 },
    });
  });

  it("resetPrices drops both runtime setPrice and applyPricingOverrides edits", () => {
    setPrice("custom-a", { input_per_mtok: 1, output_per_mtok: 2 });
    applyPricingOverrides({
      "custom-b": { input_per_mtok: 3, output_per_mtok: 4 },
    });
    expect(hasPrice("custom-a")).toBe(false); // applyPricingOverrides resets first
    expect(hasPrice("custom-b")).toBe(true);
    resetPrices();
    expect(hasPrice("custom-b")).toBe(false);
    expect(listPricingOverrides()).toEqual({});
  });

  it("listEffectivePricing exposes both defaults and overrides", () => {
    applyPricingOverrides({
      "deepseek-v4-flash": { input_per_mtok: 0.10, output_per_mtok: 0.40 },
    });
    const eff = listEffectivePricing();
    expect(eff["deepseek-v4-flash"]).toBeDefined();
    expect(eff["gpt-4o"]).toBeDefined();
  });
});
