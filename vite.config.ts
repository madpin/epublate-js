import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Service-worker / install manifest. The app is a static SPA, so
    // every screen + every Dexie write is offline-capable once the
    // shell is precached. Two runtime-cache rules cover the
    // optional embedding side-paths that go to third-party hosts —
    // both are explicitly allow-listed in
    // `.cursor/rules/no-network-side-effects.mdc`. We do NOT add a
    // third-party endpoint here, ever.
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "sample.epub"],
      manifest: {
        name: "epublate",
        short_name: "epublate",
        description:
          "Browser-only ePub translation studio with a per-project lore bible.",
        theme_color: "#1f1f23",
        background_color: "#0a0a0c",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      workbox: {
        // Precache the shell. `wasm` covers any future ONNX/WASM
        // bundled chunks; `webp`/`json` cover icon/asset variants
        // that pop up after dependency upgrades.
        globPatterns: ["**/*.{js,css,html,svg,woff2,wasm,webp,json}"],
        // Don't cache the sample ePub by default — it's heavy and only
        // a small subset of users will use it. Loaded lazily.
        globIgnores: ["**/sample.epub"],
        // SPA deep links must resolve offline. `index.html` boots the
        // router which then renders the requested route from Dexie.
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//],
        // Drop precache entries from old builds so storage doesn't
        // grow unbounded across releases.
        cleanupOutdatedCaches: true,
        // Transformers tokenizer/runtime chunks blow past the 2 MiB
        // workbox default; without this they're silently skipped and
        // local embeddings break offline.
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        runtimeCaching: [
          {
            // ONNX runtime WASM that `@xenova/transformers` pulls
            // alongside the model weights. Hash-pinned by jsdelivr,
            // so a long TTL is safe.
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/@xenova\/transformers\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "epublate-onnx-runtime",
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // HuggingFace `Xenova/*` model weights. Already cached by
            // transformers.js itself in `transformers-cache`; this is
            // belt-and-suspenders so a request that bypasses
            // transformers' cache (re-fetch on hash mismatch, future
            // SDK rev) still hits a Workbox cache instead of failing
            // offline. Content-addressed → 1-year TTL.
            urlPattern: /^https:\/\/huggingface\.co\/Xenova\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "epublate-hf-models",
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
