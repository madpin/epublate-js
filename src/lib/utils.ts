import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind classes idempotently.
 *
 * Mirrors the standard shadcn/ui helper: clsx joins inputs, twMerge
 * resolves Tailwind conflicts so later utilities win deterministically.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
