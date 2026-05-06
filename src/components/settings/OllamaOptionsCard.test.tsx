/**
 * Component coverage for the Settings → Ollama options card.
 *
 * The card is a thin shell around `useAppStore`; we mock the store
 * so each test can drive a different `llm.base_url` /
 * `llm.ollama_options` snapshot deterministically. We also mock
 * `sonner` to silence toasts and assert on the captured calls.
 *
 * Each test wraps the card in a `TooltipProvider` so the radix
 * tooltips don't blow up on mount in jsdom.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_LLM_CONFIG } from "@/db/library";
import type { LibraryLlmConfigRow } from "@/db/schema";

vi.mock("@/state/app", () => ({
  useAppStore: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}));

import { useAppStore } from "@/state/app";
import { OllamaOptionsCard } from "./OllamaOptionsCard";

// Cast the mocked hook to `any` for the implementation slot — the
// real `UseBoundStore<StoreApi<AppStore>>` signature is overloaded
// (selector / no-selector / equality), and reproducing every overload
// for the test mock is more verbose than the test it backs.
const mocked_store = useAppStore as unknown as ReturnType<typeof vi.fn>;

interface StoreSnapshot {
  llm: LibraryLlmConfigRow;
  setLlmConfig: ReturnType<typeof vi.fn>;
}

function primeStore(opts: {
  base_url?: string;
  ollama_options?: LibraryLlmConfigRow["ollama_options"];
}): StoreSnapshot {
  const setLlmConfig = vi.fn().mockResolvedValue(undefined);
  const snapshot: StoreSnapshot = {
    llm: {
      ...DEFAULT_LLM_CONFIG,
      base_url: opts.base_url ?? DEFAULT_LLM_CONFIG.base_url,
      ollama_options: opts.ollama_options ?? null,
    },
    setLlmConfig,
  };
  mocked_store.mockImplementation((selector?: (state: StoreSnapshot) => unknown) =>
    selector ? selector(snapshot) : snapshot,
  );
  return snapshot;
}

function renderCard(): void {
  render(
    <TooltipProvider>
      <OllamaOptionsCard />
    </TooltipProvider>,
  );
}

/**
 * The card renders a `<button aria-label="Help for …">` next to each
 * field's `<label>`, so a regex like `/Context window/` matches both
 * elements via `getByLabelText`. Querying the input by its stable id
 * sidesteps the ambiguity without weakening test intent.
 */
function numCtxInput(): HTMLInputElement {
  const el = document.getElementById("ollama_opt_num_ctx");
  if (!(el instanceof HTMLInputElement)) {
    throw new Error("num_ctx input not found");
  }
  return el;
}

describe("OllamaOptionsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("collapses to the 'Show anyway' state when the URL doesn't look like Ollama", () => {
    primeStore({ base_url: "https://api.openai.com/v1" });
    renderCard();
    expect(
      screen.getByText(/doesn't look like an Ollama endpoint/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show anyway/i })).toBeInTheDocument();
    // The form fields should not have rendered yet.
    expect(document.getElementById("ollama_opt_num_ctx")).toBeNull();
  });

  it("auto-expands when the URL contains :11434", () => {
    primeStore({ base_url: "http://localhost:11434/v1" });
    renderCard();
    expect(numCtxInput()).toBeInTheDocument();
    expect(screen.getByText(/Quick presets/i)).toBeInTheDocument();
    expect(screen.getByText(/Detected/i)).toBeInTheDocument();
  });

  it("reveals the form on 'Show anyway' even for cloud URLs", () => {
    primeStore({ base_url: "https://api.openai.com/v1" });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /Show anyway/i }));
    expect(numCtxInput()).toBeInTheDocument();
  });

  it("commits a typed value on blur and persists it via setLlmConfig", async () => {
    const snapshot = primeStore({ base_url: "http://localhost:11434" });
    renderCard();
    const input = numCtxInput();
    fireEvent.change(input, { target: { value: "8192" } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    // setLlmConfig is async; wait for the next microtask.
    await Promise.resolve();
    expect(snapshot.setLlmConfig).toHaveBeenCalledTimes(1);
    expect(snapshot.setLlmConfig).toHaveBeenCalledWith({
      ollama_options: { num_ctx: 8192 },
    });
  });

  it("'Clear all' wipes every override and saves null", async () => {
    const snapshot = primeStore({
      base_url: "http://localhost:11434",
      ollama_options: { num_ctx: 8192, temperature: 0.3 },
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /Clear all/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await Promise.resolve();
    expect(snapshot.setLlmConfig).toHaveBeenCalledWith({
      ollama_options: null,
    });
  });

  it("applying a preset stages preset values into the form", () => {
    primeStore({ base_url: "http://localhost:11434" });
    renderCard();
    const preset = screen.getByRole("button", {
      name: /Translation \(8K context\)/i,
    });
    fireEvent.click(preset);
    expect(numCtxInput().value).toBe("8192");
  });

  it("exposes the override-count badge after a value is typed", () => {
    primeStore({
      base_url: "http://localhost:11434",
      ollama_options: { num_ctx: 16384, temperature: 0.3 },
    });
    renderCard();
    expect(screen.getByText("2 overrides")).toBeInTheDocument();
  });

  it("renders the `think` boolean as a tri-state select and saves the chosen value", async () => {
    const snapshot = primeStore({ base_url: "http://localhost:11434" });
    renderCard();
    const sel = document.getElementById("ollama_opt_think");
    expect(sel).toBeInstanceOf(HTMLSelectElement);
    // Default state is "use model default" (empty string value).
    expect((sel as HTMLSelectElement).value).toBe("");
    fireEvent.change(sel as HTMLSelectElement, { target: { value: "false" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await Promise.resolve();
    expect(snapshot.setLlmConfig).toHaveBeenCalledWith({
      ollama_options: { think: false },
    });
  });

  it("persists existing `think: false` and round-trips through Save", async () => {
    const snapshot = primeStore({
      base_url: "http://localhost:11434",
      ollama_options: { think: false, num_ctx: 8192 },
    });
    renderCard();
    // The select should reflect the persisted value.
    const sel = document.getElementById(
      "ollama_opt_think",
    ) as HTMLSelectElement;
    expect(sel.value).toBe("false");
    // Toggle to true and save.
    fireEvent.change(sel, { target: { value: "true" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await Promise.resolve();
    expect(snapshot.setLlmConfig).toHaveBeenCalledWith({
      ollama_options: { think: true, num_ctx: 8192 },
    });
  });
});
