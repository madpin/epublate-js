import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { registerSW } from "virtual:pwa-register";

import { App } from "./App";
import { installConsoleLogBuffer } from "./lib/log_buffer";
import { writeOfflineReady } from "./lib/pwa";
import "./styles/globals.css";

installConsoleLogBuffer();

// vite-plugin-pwa registers the service worker on first load.
// `autoUpdate` reload on new build is configured in vite.config.ts;
// the lifecycle callbacks below surface the install state to the
// curator so they know when the app is safe to use offline and
// when a fresh build is waiting.
//
// `toast.*` calls before `<Toaster />` mounts are fine — sonner
// queues them and renders once the toaster mounts inside `AppShell`.
if (typeof window !== "undefined") {
  const updateSW = registerSW({
    immediate: true,
    onOfflineReady() {
      writeOfflineReady();
      toast.success("epublate is saved on this device", {
        description:
          "The app shell is cached locally. You can use it offline; new LLM calls still need network.",
        duration: 8_000,
      });
    },
    onNeedRefresh() {
      toast("A new version of epublate is available", {
        description: "Reload to pick up the latest build.",
        duration: Infinity,
        action: {
          label: "Reload now",
          onClick: () => {
            void updateSW(true);
          },
        },
      });
    },
    onRegisterError(err) {
      // Non-fatal: a missing SW still leaves the app fully working
      // — it just won't be installable / offline-capable. We log so
      // the curator can debug a misconfigured deploy via DevTools.
      console.warn("[pwa] service worker registration failed", err);
    },
  });
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element in index.html");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
