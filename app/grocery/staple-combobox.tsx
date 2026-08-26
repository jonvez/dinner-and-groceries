"use client";

/**
 * Type-to-find over the household's staples (issue #148).
 *
 * The Things import put 492 staples in the catalog and the one-tap chip row
 * rendered all of them, which is a wall rather than a shortcut. This is the way
 * in now: type a letter, get at most five real staples, pick one or keep typing.
 *
 * ## Why this is hand-built rather than a `<datalist>`
 *
 * The aisle picker on each row is a native `<select>` precisely because the
 * platform control is excellent. That argument does NOT carry over here.
 * `<datalist>` is unusable for this: NVDA+Firefox do not announce the options,
 * the option text does not scale when the page is zoomed, it cannot be styled
 * for high-contrast mode, and mobile behaviour differs by browser. So this
 * implements the W3C APG combobox pattern instead.
 *
 * ## The pattern, and the mistake it exists to prevent
 *
 * DOM focus NEVER leaves the input. The active option is tracked with
 * `aria-activedescendant`, not by moving focus into the list. Moving focus is
 * the classic implementation bug — it breaks typeahead, and screen readers stop
 * reading the field the user believes they are editing.
 *
 * A separate polite live region announces how many results are available,
 * because a visual "5 suggestions appeared" is invisible to a screen-reader
 * user who has no reason to arrow down and find out.
 *
 * ## Deliberately absent: a character threshold
 *
 * Suggestions start at the first character. The familiar "wait for 3" rule
 * exists to avoid *server* work on a large corpus; this catalog is already in
 * the browser, so a keystroke costs nothing. The five-result cap does the noise
 * control that the threshold used to do. (NN/g's mobile-input checklist asks
 * the opposite question: "can you make suggestions based on the FIRST letters
 * typed?")
 */

import { useCallback, useId, useMemo, useRef, useState } from "react";

import type { CatalogRow } from "./list-core";
import { suggestStaples, type StapleSuggestion } from "./suggest-core";

export type StapleComboboxProps = {
  /** The field's `name` when the form is submitted. */
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** A staple was chosen — the caller may prefill the unit from it. */
  onPick: (suggestion: StapleSuggestion) => void;
  catalog: CatalogRow[];
  disabled?: boolean;
};

export function StapleCombobox({
  name,
  label,
  value,
  onChange,
  onPick,
  catalog,
  disabled,
}: StapleComboboxProps) {
  const reactId = useId();
  const inputId = `${reactId}-input`;
  const listboxId = `${reactId}-listbox`;
  const optionId = (index: number) => `${reactId}-option-${index}`;

  // `dismissed` is separate from "no suggestions": Escape must be able to hide
  // a list the query still matches, without clearing what was typed.
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(
    () => suggestStaples(value, catalog),
    [value, catalog],
  );
  const open = !dismissed && suggestions.length > 0;

  const pick = useCallback(
    (suggestion: StapleSuggestion) => {
      onChange(suggestion.name);
      onPick(suggestion);
      setDismissed(true);
      setActive(-1);
      // Focus never left, but make it explicit: the user is still editing the
      // field, not standing in a list that has just vanished.
      inputRef.current?.focus();
    },
    [onChange, onPick],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        setDismissed(true);
        setActive(-1);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (suggestions.length === 0) return;
        event.preventDefault(); // don't move the caret while navigating
        setDismissed(false);
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((prev) => {
          const next = prev + step;
          // Wrap, so a thumb on a phone can reach the last item downward.
          if (next < 0) return suggestions.length - 1;
          if (next >= suggestions.length) return 0;
          return next;
        });
        return;
      }
      if (event.key === "Enter" && open && active >= 0) {
        // Choosing a suggestion must not also submit the form — adding the
        // item stays a separate, deliberate press.
        event.preventDefault();
        pick(suggestions[active]);
      }
    },
    [suggestions, open, active, pick],
  );

  const status = !open
    ? ""
    : suggestions.length === 1
      ? "1 staple found. Use the up and down arrows to review, then Enter to choose it."
      : `${suggestions.length} staples found. Use the up and down arrows to review, then Enter to choose one.`;

  return (
    <div className="flex flex-1 flex-col gap-1">
      {/* Label ABOVE the field, and no placeholder standing in for it — a
          placeholder disappears exactly when the user needs it most. */}
      <label
        htmlFor={inputId}
        className="text-muted-foreground text-xs font-medium"
      >
        {label}
      </label>
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          name={name}
          value={value}
          disabled={disabled}
          maxLength={200}
          required
          // The browser's own history dropdown would cover ours.
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && active >= 0 ? optionId(active) : undefined
          }
          onChange={(e) => {
            onChange(e.target.value);
            setDismissed(false);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
          className="border-input bg-background w-full rounded-md border px-3 py-1.5 text-sm"
        />

        <ul
          id={listboxId}
          role="listbox"
          aria-label={`${label} suggestions`}
          hidden={!open}
          data-testid="staple-suggestions"
          className="border-input bg-background absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border shadow-md"
        >
          {/* Rendered ONLY while open. Hiding the list with `hidden` but
              leaving the options mounted would keep them queryable, and would
              let `aria-activedescendant` reference an element that is not in
              the accessibility tree. */}
          {open &&
            suggestions.map((suggestion, index) => (
              <li
                key={suggestion.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                data-testid="staple-suggestion"
                // onMouseDown, not onClick: mousedown fires before the input's
                // blur, so the list is still mounted when the tap lands.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(suggestion);
                }}
                className={`cursor-pointer px-3 py-2.5 text-sm ${
                  index === active ? "bg-accent" : ""
                }`}
              >
                {/* Bold the text the user typed. NN/g's rule is conditional —
                  emphasise the suggestion when it only appends, emphasise the
                  QUERY when the match can land anywhere, as it can here. */}
                <span>
                  {suggestion.segments.before}
                  <strong className="font-semibold">
                    {suggestion.segments.match}
                  </strong>
                  {suggestion.segments.after}
                </span>
              </li>
            ))}
        </ul>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {status}
      </div>
    </div>
  );
}
