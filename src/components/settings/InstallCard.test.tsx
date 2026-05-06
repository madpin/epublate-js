/**
 * Component test for the Settings → Install card.
 *
 * The card is a thin shell over three hooks (`usePwaInstall`,
 * `useOnlineStatus`, `useOfflineReady`); we vi.mock them so the test
 * can drive each branch (can-install / installed / running-as-app /
 * unsupported) deterministically. The hooks themselves have their own
 * unit tests in `src/hooks/`.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/hooks/usePwaInstall", () => ({
  usePwaInstall: vi.fn(),
}));
vi.mock("@/hooks/useOnlineStatus", () => ({
  useOnlineStatus: vi.fn(),
}));
vi.mock("@/hooks/useOfflineReady", () => ({
  useOfflineReady: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

import { useOfflineReady } from "@/hooks/useOfflineReady";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { usePwaInstall } from "@/hooks/usePwaInstall";
import { InstallCard } from "./InstallCard";

const mocked_install = vi.mocked(usePwaInstall);
const mocked_online = vi.mocked(useOnlineStatus);
const mocked_ready = vi.mocked(useOfflineReady);

function setHooks(opts: {
  can_install?: boolean;
  installed?: boolean;
  running?: boolean;
  online?: boolean;
  ready?: boolean;
  prompt?: () => Promise<"accepted" | "dismissed" | "unsupported">;
}): {
  prompt: () => Promise<"accepted" | "dismissed" | "unsupported">;
} {
  const prompt =
    opts.prompt ??
    (vi.fn().mockResolvedValue("accepted") as () => Promise<
      "accepted" | "dismissed" | "unsupported"
    >);
  mocked_install.mockReturnValue({
    can_install: opts.can_install ?? false,
    installed: opts.installed ?? false,
    running_as_installed_app: opts.running ?? false,
    prompt,
  });
  mocked_online.mockReturnValue(opts.online ?? true);
  mocked_ready.mockReturnValue(opts.ready ?? false);
  return { prompt };
}

describe("InstallCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the available-to-install state and triggers prompt() on click", async () => {
    const { prompt } = setHooks({ can_install: true, ready: true, online: true });
    render(<InstallCard />);

    expect(screen.getByText("Available to install")).toBeInTheDocument();
    expect(screen.getByText("App cached for offline use")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();

    const button = screen.getByRole("button", { name: /Install epublate/ });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("disables the install button when already installed in this session", () => {
    setHooks({ installed: true, ready: true });
    render(<InstallCard />);
    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Install epublate/ }),
    ).toBeDisabled();
  });

  it("disables the install button when running as the installed app", () => {
    setHooks({ running: true, ready: true });
    render(<InstallCard />);
    expect(screen.getByText("Running as installed app")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Install epublate/ }),
    ).toBeDisabled();
  });

  it("disables the install button and shows fall-back hint on unsupported browsers", () => {
    setHooks({ can_install: false });
    render(<InstallCard />);
    expect(screen.getByText("Browser-managed install")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Install epublate/ }),
    ).toBeDisabled();
    expect(
      screen.getByText(/No install prompt available yet/),
    ).toBeInTheDocument();
  });

  it("renders the offline pill when navigator is offline", () => {
    setHooks({ online: false, ready: true });
    render(<InstallCard />);
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("renders the caching pill before onOfflineReady has fired", () => {
    setHooks({ ready: false });
    render(<InstallCard />);
    expect(screen.getByText("Caching app for offline use…")).toBeInTheDocument();
  });
});
