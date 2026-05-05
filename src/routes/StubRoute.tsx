import * as React from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";

/**
 * Generic placeholder for routes whose UI lands in a later phase
 * (P1–P9). The screen renders the route's intent + which phase
 * builds it, so the navigation skeleton is testable in P0.
 */
export interface StubProps {
  title: string;
  description: string;
  phase: string;
}

export function StubRoute({ title, description, phase }: StubProps): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </header>
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="rounded-lg border border-dashed bg-card/30 p-8 text-center">
          <div className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">
            Coming up
          </div>
          <div className="mb-4 text-sm">
            This screen lands in <span className="font-semibold">{phase}</span>.
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/">Back to projects</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
