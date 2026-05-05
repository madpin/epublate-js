import { Toaster as SonnerToaster, type ToasterProps } from "sonner";

/**
 * App-wide toaster. Uses CSS vars from `globals.css` so it picks up
 * the active theme automatically.
 */
export function Toaster(props: ToasterProps): React.JSX.Element {
  return (
    <SonnerToaster
      theme="system"
      position="bottom-right"
      closeButton
      richColors
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}
