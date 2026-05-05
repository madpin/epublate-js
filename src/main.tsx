import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./App";
import { installConsoleLogBuffer } from "./lib/log_buffer";
import "./styles/globals.css";

installConsoleLogBuffer();

// vite-plugin-pwa registers the service worker on first load.
// `autoUpdate` reload on new build is configured in vite.config.ts.
if (typeof window !== "undefined") {
  registerSW({ immediate: true });
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element in index.html");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
