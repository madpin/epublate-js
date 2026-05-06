/**
 * Settings → Install card.
 *
 * Surfaces the "save the app to this device" affordance and tells the
 * curator at a glance whether epublate is currently:
 *
 *   - Installable on this browser (deferred `beforeinstallprompt`
 *     was captured) — show the "Install" button.
 *   - Already running inside the installed PWA — show a green
 *     "Running as installed app" pill, no button.
 *   - Just installed in this session — green "Installed" pill, no
 *     button.
 *   - Browser-doesn't-support — show a muted pill explaining why,
 *     plus instructions for the manual fall-back (Chrome's
 *     omnibar icon, Firefox's "Install" extension, Safari's
 *     "Add to Home Screen").
 *
 * Two extra pills in the same card track the offline guarantees:
 *
 *   - "App cached for offline use" once Workbox has reported
 *     `onOfflineReady`. Driven by `useOfflineReady` so a refresh
 *     after install flips it without UI logic.
 *   - "Online" / "Offline" status, surfaced from `navigator.onLine`.
 *     We render it here as well as in the AppShell footer because
 *     the offline-while-translating failure mode is most actionable
 *     from this screen (the curator can verify they're actually
 *     online before retrying a batch).
 */

import * as React from "react";
import { CheckCircle2, CloudDownload, Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useOfflineReady } from "@/hooks/useOfflineReady";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { usePwaInstall } from "@/hooks/usePwaInstall";

export function InstallCard(): React.JSX.Element {
  const install = usePwaInstall();
  const offline_ready = useOfflineReady();
  const online = useOnlineStatus();

  const onInstall = async (): Promise<void> => {
    const outcome = await install.prompt();
    if (outcome === "accepted") {
      toast.success("epublate is now installed on this device.");
    } else if (outcome === "dismissed") {
      toast("Install dismissed", {
        description:
          "You can install epublate later from this card or from your browser's address bar.",
      });
    } else {
      // "unsupported" — the deferred prompt expired or the browser
      // never fired one. We surface a hint so the curator knows the
      // omnibar / "Add to Home Screen" path.
      toast(
        "This browser doesn't expose the install prompt to the page.",
        {
          description:
            "Use your browser's own install option: Chrome's address-bar icon, Firefox's Page Actions menu, or Safari's Share → Add to Home Screen.",
          duration: 12_000,
        },
      );
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CloudDownload className="size-4 text-primary" />
          Install for offline use
        </CardTitle>
        <CardDescription>
          epublate is a fully local app. Installing it saves the shell
          to this device so you can open it from your dock or home
          screen and use every screen — including cache-hit
          translations — without a network connection.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <InstallBadge install={install} />
          <OfflineCacheBadge ready={offline_ready} />
          <OnlineBadge online={online} />
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Once installed, you can do everything offline except making{" "}
          <em>new</em> LLM or embedding calls — those need network by
          definition. Translations you've already generated, glossary
          edits, ePub re-exports, and cache hits all keep working
          when you're disconnected.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => {
              void onInstall();
            }}
            disabled={
              install.installed ||
              install.running_as_installed_app ||
              !install.can_install
            }
            className="gap-2"
            title={
              install.running_as_installed_app
                ? "You're already running the installed app."
                : install.installed
                  ? "Already installed in this session."
                  : install.can_install
                    ? "Save epublate to your device."
                    : "Your browser hasn't offered an install prompt for this page yet."
            }
          >
            <CloudDownload className="size-4" />
            Install epublate
          </Button>
          {install.can_install ||
          install.installed ||
          install.running_as_installed_app ? null : (
            <p className="text-xs text-muted-foreground">
              No install prompt available yet — the browser usually
              waits until you've used the app a little. You can also
              install via your browser's address-bar icon (Chrome),
              Page Actions menu (Firefox), or Share → Add to Home
              Screen (Safari).
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function InstallBadge({
  install,
}: {
  install: ReturnType<typeof usePwaInstall>;
}): React.JSX.Element {
  if (install.running_as_installed_app) {
    return (
      <Badge variant="success" className="gap-1.5">
        <CheckCircle2 className="size-3" />
        Running as installed app
      </Badge>
    );
  }
  if (install.installed) {
    return (
      <Badge variant="success" className="gap-1.5">
        <CheckCircle2 className="size-3" />
        Installed
      </Badge>
    );
  }
  if (install.can_install) {
    return (
      <Badge variant="secondary" className="gap-1.5">
        <CloudDownload className="size-3" />
        Available to install
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1.5 text-muted-foreground">
      Browser-managed install
    </Badge>
  );
}

function OfflineCacheBadge({ ready }: { ready: boolean }): React.JSX.Element {
  if (ready) {
    return (
      <Badge variant="success" className="gap-1.5">
        <CheckCircle2 className="size-3" />
        App cached for offline use
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1.5 text-muted-foreground">
      Caching app for offline use…
    </Badge>
  );
}

function OnlineBadge({ online }: { online: boolean }): React.JSX.Element {
  if (online) {
    return (
      <Badge variant="outline" className="gap-1.5 text-muted-foreground">
        <Wifi className="size-3" />
        Online
      </Badge>
    );
  }
  return (
    <Badge variant="warning" className="gap-1.5">
      <WifiOff className="size-3" />
      Offline
    </Badge>
  );
}
