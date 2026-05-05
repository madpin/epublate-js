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
    // Service-worker / install manifest. Cache strategy is wired up in P6;
    // for now we ship the manifest so the app is installable, with a
    // generateSW that just caches the build artifacts.
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
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        // Don't cache the sample ePub by default — it's heavy and only
        // a small subset of users will use it. Loaded lazily.
        globIgnores: ["**/sample.epub"],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
