import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest config for `npm run bench`. The synthetic benchmark lives
 * in `tools/bench.ts` and isn't picked up by the default `*.test.ts`
 * include pattern in `vitest.config.ts` — keeping it separate means
 * `npm test` stays fast and predictable, while `npm run bench` runs
 * one wall-clock pass over `docs/petitprince.epub`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["tools/bench.ts"],
  },
});
