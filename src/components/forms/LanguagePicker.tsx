/**
 * LanguagePicker — autocompleting BCP-47 input.
 *
 * The control is a thin wrapper around the standard `<input>` paired
 * with a custom popover list (we don't use `<datalist>` because Safari
 * silently truncates large lists and Firefox renders the auto-suggest
 * in alphabetical order regardless of our ranking).
 *
 * Behaviour:
 *   - Free text typing is allowed — curators can use codes we haven't
 *     catalogued yet (e.g. niche regional tags). Validity feedback is
 *     informational, never destructive.
 *   - Dropdown ranks by exact > prefix > substring match against the
 *     tag *and* the localised name, capped at 12 entries.
 *   - Down-arrow / Up-arrow / Enter / Escape navigate the suggestion
 *     list. Tab commits the highlighted suggestion as you'd expect.
 *   - Out of focus, we render a small "Unknown tag" hint underneath
 *     when `validateOnBlur` is set and the value isn't recognised.
 */

import * as React from "react";

import { cn } from "@/lib/utils";
import {
  describeLanguage,
  findLanguage,
  searchLanguages,
  type LanguageOption,
} from "@/lib/languages";

interface LanguagePickerProps {
  id?: string;
  value: string;
  onChange(next: string): void;
  placeholder?: string;
  disabled?: boolean;
  /** Wraps the input + dropdown together for layout purposes. */
  className?: string;
  /** Flips the ring red and renders an "unknown tag" subtitle. */
  validateOnBlur?: boolean;
  /** Forwarded to the underlying input — useful for keyboard tests. */
  inputRef?: React.Ref<HTMLInputElement>;
}

const ITEM_HEIGHT = 36;

export function LanguagePicker({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  className,
  validateOnBlur,
  inputRef,
}: LanguagePickerProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);
  const [touched, setTouched] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const localInputRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLUListElement | null>(null);

  const setRef = React.useCallback(
    (node: HTMLInputElement | null): void => {
      localInputRef.current = node;
      if (typeof inputRef === "function") inputRef(node);
      else if (inputRef && "current" in inputRef) {
        (inputRef as React.MutableRefObject<HTMLInputElement | null>).current =
          node;
      }
    },
    [inputRef],
  );

  const suggestions = React.useMemo<LanguageOption[]>(
    () => searchLanguages(value, 12),
    [value],
  );

  const known = findLanguage(value);
  const showInvalid =
    validateOnBlur && touched && value.trim() !== "" && !known;

  // Re-clamp the highlight whenever the suggestion list shrinks past
  // the cursor.
  React.useEffect(() => {
    if (highlight >= suggestions.length) {
      setHighlight(Math.max(0, suggestions.length - 1));
    }
  }, [highlight, suggestions.length]);

  // Outside-click closes the popover. Mousedown handler prevents the
  // input from losing focus before the click actually lands.
  React.useEffect(() => {
    if (!open) return;
    const handler = (ev: MouseEvent): void => {
      const root = containerRef.current;
      if (!root) return;
      if (!root.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const commit = React.useCallback(
    (option: LanguageOption): void => {
      onChange(option.code);
      setOpen(false);
      // Re-focus to keep keyboard flow working when the curator picks
      // via mouse on a tab-only form.
      localInputRef.current?.focus();
    },
    [onChange],
  );

  const onKeyDown = (ev: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!open) {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        setOpen(true);
        ev.preventDefault();
      }
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setHighlight((h) => (h + 1) % Math.max(1, suggestions.length));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setHighlight(
        (h) =>
          (h - 1 + Math.max(1, suggestions.length)) %
          Math.max(1, suggestions.length),
      );
    } else if (ev.key === "Enter" || ev.key === "Tab") {
      const cur = suggestions[highlight];
      if (cur) {
        ev.preventDefault();
        commit(cur);
      }
    } else if (ev.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <input
        id={id}
        ref={setRef}
        value={value}
        onChange={(ev) => {
          onChange(ev.target.value);
          if (!open) setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setTouched(true);
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? "e.g. en, pt-BR, ja"}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-invalid={showInvalid || undefined}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          showInvalid && "border-destructive focus-visible:ring-destructive",
        )}
      />
      {open && suggestions.length > 0 ? (
        <ul
          ref={listRef}
          role="listbox"
          className="absolute left-0 right-0 z-50 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-lg"
          style={{ scrollbarGutter: "stable" }}
        >
          {suggestions.map((opt, i) => {
            const isHighlighted = i === highlight;
            const isCurrent = value.trim().toLowerCase() === opt.key;
            return (
              <li key={opt.code}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isHighlighted}
                  onMouseDown={(ev) => {
                    // Prevent the input from blurring before we commit.
                    ev.preventDefault();
                    commit(opt);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded px-2 text-left",
                    isHighlighted && "bg-accent text-accent-foreground",
                    !isHighlighted && isCurrent && "bg-accent/40",
                  )}
                  style={{ height: ITEM_HEIGHT }}
                >
                  <span className="truncate">{opt.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {opt.code}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {showInvalid ? (
        <p className="mt-1 text-[11px] text-destructive">
          Unknown language tag. The translator will still try, but
          stick to BCP-47 codes (e.g. <code>en</code>,{" "}
          <code>pt-BR</code>) so prompts and pricing line up.
        </p>
      ) : known && value.trim() !== "" && value.trim() !== known.code ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Recognized as <strong>{describeLanguage(value)}</strong> — use{" "}
          <code>{known.code}</code> to match the canonical tag.
        </p>
      ) : null}
    </div>
  );
}
