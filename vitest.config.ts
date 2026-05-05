import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest config kept separate from `vite.config.ts` so Vitest's
 * bundled-vite types don't collide with the Vite + plugin types we
 * use in production. We mirror only the parts of the Vite config
 * that the tests need (path alias).
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
    // `scripts/` houses one-off diagnostic probes (e.g. the
    // `epubcheck` round-trip dumper) that read fixtures from `/tmp/`
    // and aren't real unit tests. Run them on demand via
    // `npx vitest run scripts/...` rather than every `npm test`.
    exclude: ["**/node_modules/**", "**/dist/**", "scripts/**"],
  },
});
