/**
 * Renders the source ePub's cover image as an `<img>`-driven
 * thumbnail, with a deterministic letter fallback for projects that
 * predate cover extraction (or whose ePub didn't advertise a cover).
 *
 * Implementation notes:
 *
 * - Bytes are passed in as `ArrayBuffer | null | undefined`. We turn
 *   them into a stable `blob:` URL inside `useMemo`/`useEffect` and
 *   call `URL.revokeObjectURL` on unmount/replacement so we don't leak
 *   the blob through the page lifetime. (`hundreds of books` in a
 *   list would otherwise pin tens of MB of cover data.)
 * - The fallback uses the project's `name` initial to produce a tile
 *   that visually distinguishes books in a long Projects list without
 *   relying on the ePub having emitted a cover.
 */

import * as React from "react";
import { Book } from "lucide-react";

import { cn } from "@/lib/utils";

interface CoverThumbProps {
  bytes?: ArrayBuffer | null;
  media_type?: string | null;
  /** Project / book title used for the alt text and the fallback tile. */
  name: string;
  className?: string;
  /** "card" => rounded corners, full bleed (Projects list, lore book list)
   *  "tile" => taller aspect, larger fallback letter (Dashboard sidebar). */
  variant?: "card" | "tile";
}

export function CoverThumb({
  bytes,
  media_type,
  name,
  className,
  variant = "card",
}: CoverThumbProps): React.JSX.Element {
  const url = useObjectUrl(bytes, media_type ?? null);

  const initial = (name?.trim().charAt(0) || "?").toUpperCase();

  const aspect =
    variant === "tile" ? "aspect-[2/3]" : "aspect-[3/4]";

  if (!url) {
    return (
      <div
        className={cn(
          "relative flex shrink-0 items-center justify-center overflow-hidden rounded-md border bg-gradient-to-br from-muted to-muted/50",
          aspect,
          className,
        )}
        aria-label={`${name} (no cover)`}
        role="img"
      >
        <span className="select-none font-serif text-3xl font-semibold text-muted-foreground/80">
          {initial}
        </span>
        <Book className="absolute bottom-1.5 right-1.5 size-3 text-muted-foreground/60" />
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={`${name} cover`}
      className={cn(
        "shrink-0 rounded-md border bg-card object-cover",
        aspect,
        className,
      )}
      loading="lazy"
    />
  );
}

function useObjectUrl(
  bytes: ArrayBuffer | null | undefined,
  media_type: string | null,
): string | null {
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!bytes || bytes.byteLength === 0) {
      setUrl(null);
      return;
    }
    const type = media_type && media_type !== "" ? media_type : "image/*";
    const blob = new Blob([bytes], { type });
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => {
      URL.revokeObjectURL(u);
    };
  }, [bytes, media_type]);

  return url;
}
