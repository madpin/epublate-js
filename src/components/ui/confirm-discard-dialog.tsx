/**
 * Reusable "are you sure?" confirmation dialog used by modals that
 * collect time-consuming or hard-to-recover input.
 *
 * The typical pattern is: a parent modal blocks its own implicit close
 * paths (`onPointerDownOutside`, `onEscapeKeyDown`) when the user has
 * meaningful in-progress state, and instead pops this confirm. The
 * curator can then explicitly choose between discarding the work or
 * returning to the form.
 *
 * Stays intentionally small: title + description + two buttons. Pair
 * it with `useConfirmDiscard` (below) for the bookkeeping.
 */
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ConfirmDiscardDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Headline of the confirm. */
  title?: string;
  /** Body text — explain what will be lost. */
  description?: React.ReactNode;
  /** Label for the destructive action. */
  discard_label?: string;
  /** Label for the "go back to the form" action. */
  keep_label?: string;
  /** Fired when the curator confirms the discard. */
  onConfirm(): void;
}

export function ConfirmDiscardDialog({
  open,
  onOpenChange,
  title = "Discard changes?",
  description = "You have in-progress work. Closing now will lose your input.",
  discard_label = "Discard",
  keep_label = "Keep editing",
  onConfirm,
}: ConfirmDiscardDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            {keep_label}
          </Button>
          <Button
            variant="destructive"
            type="button"
            onClick={onConfirm}
            autoFocus
          >
            {discard_label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface UseConfirmDiscardOptions {
  /**
   * When true, implicit-close paths (click outside, escape) are
   * intercepted and the confirm dialog opens instead. When false the
   * dialog closes immediately without prompting.
   */
  enabled: boolean;
}

export interface UseConfirmDiscardResult {
  /**
   * Spread on the underlying `DialogContent`. Calls `preventDefault`
   * on outside-clicks and escape-keys when `enabled`, then opens the
   * confirm.
   */
  contentProps: {
    onPointerDownOutside(event: Event): void;
    onEscapeKeyDown(event: KeyboardEvent): void;
  };
  confirm_open: boolean;
  setConfirmOpen(next: boolean): void;
}

/**
 * Hook that wires a confirm-on-implicit-close pattern onto a Radix
 * Dialog. Returns the props to spread on `DialogContent` plus the
 * confirm dialog's open state. The caller renders
 * `<ConfirmDiscardDialog>` separately so the copy can be tailored.
 */
export function useConfirmDiscard(
  opts: UseConfirmDiscardOptions,
): UseConfirmDiscardResult {
  const [confirm_open, setConfirmOpen] = React.useState(false);
  const enabled = opts.enabled;

  const guard = React.useCallback(
    (event: Event) => {
      if (!enabled) return;
      event.preventDefault();
      setConfirmOpen(true);
    },
    [enabled],
  );

  return {
    contentProps: {
      onPointerDownOutside: guard,
      onEscapeKeyDown: guard,
    },
    confirm_open,
    setConfirmOpen,
  };
}
