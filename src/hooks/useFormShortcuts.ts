/**
 * `useFormShortcuts` — wires Ctrl/Cmd+S as an alternate submit accelerator
 * for modal forms. The native Enter-to-submit binding still works inside
 * single-line text inputs; this hook adds Ctrl+S so curators with a hand
 * on the textarea can save without leaving the keyboard.
 *
 * Pass the `formRef` of the `<form>` element you want bound, plus a
 * boolean `enabled` (e.g. tied to the dialog's `open` state). The hook
 * dispatches a synthetic `submit` event so React's `onSubmit` handler
 * runs exactly the same way as if the curator had clicked the submit
 * button.
 */

import * as React from "react";

export function useFormShortcuts(
  formRef: React.RefObject<HTMLFormElement | null>,
  enabled: boolean,
): void {
  React.useEffect(() => {
    if (!enabled) return;
    const handler = (ev: KeyboardEvent): void => {
      if (!(ev.metaKey || ev.ctrlKey)) return;
      if (ev.key.toLowerCase() !== "s") return;
      const form = formRef.current;
      if (!form) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        form.dispatchEvent(
          new Event("submit", { cancelable: true, bubbles: true }),
        );
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [formRef, enabled]);
}
