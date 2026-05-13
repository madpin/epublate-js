import * as React from "react";
import { RouterProvider } from "react-router-dom";

import { router } from "./router";
import { useAppStore } from "@/state/app";
import { installBatchStatePersistence } from "@/state/batch_persist";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Root component. Hydrates the app store on mount, then mounts the
 * router. While we hydrate (≈single read of the library DB) we show a
 * minimal splash so the wrong theme doesn't flash.
 */
export function App(): React.JSX.Element {
  const ready = useAppStore((s) => s.ready);
  const hydrate = useAppStore((s) => s.hydrate);

  React.useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Mirror the batch store into the library DB once hydration has
  // finished. We delay until `ready` so the hydrate's initial
  // `setState({active, queue})` doesn't immediately bounce back to
  // disk (the row would already be the same shape; harmless but
  // wasteful), and so the persistence layer's `pagehide` handler
  // doesn't misfire if hydration ever errors out.
  React.useEffect(() => {
    if (!ready) return;
    installBatchStatePersistence();
  }, [ready]);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading epublate…
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <RouterProvider router={router} />
    </TooltipProvider>
  );
}
