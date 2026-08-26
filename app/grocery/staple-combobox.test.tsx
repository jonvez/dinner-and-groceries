import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { CatalogRow } from "./list-core";
import { StapleCombobox } from "./staple-combobox";

/**
 * The staple combobox (#148). The matcher is exhaustively tested in
 * `suggest-core`; what's pinned here is the WIRING and the accessibility
 * contract, which is the part that regresses silently:
 *   - DOM focus NEVER moves into the list — the active option is tracked with
 *     `aria-activedescendant`. Moving focus is the classic bug: it breaks
 *     typeahead and stops screen readers reading the field being edited.
 *   - Enter on an active option chooses it and does NOT submit the form;
 *     adding the item stays a separate, deliberate press.
 *   - a count is announced in a polite live region, because "five suggestions
 *     appeared" is invisible to someone who has no reason to arrow down.
 */

const staple = (o: Partial<CatalogRow> & { id: string; name: string }): CatalogRow => ({
  defaultUnit: null,
  addedCount: 0,
  ...o,
});

const CATALOG: CatalogRow[] = [
  staple({ id: "1", name: "molasses" }),
  staple({ id: "2", name: "Monkfruit" }),
  staple({ id: "3", name: "mop heads" }),
  staple({ id: "4", name: "Milk", defaultUnit: "gal" }),
  staple({ id: "5", name: "olive oil" }),
];

function Harness({
  onPick = vi.fn(),
  onSubmit = vi.fn(),
  catalog = CATALOG,
}: {
  onPick?: (s: { name: string; defaultUnit: string | null }) => void;
  onSubmit?: () => void;
  catalog?: CatalogRow[];
}) {
  const [value, setValue] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <StapleCombobox
        name="name"
        label="Item"
        value={value}
        onChange={setValue}
        onPick={onPick}
        catalog={catalog}
      />
      <button type="submit">Add</button>
    </form>
  );
}

const input = () => screen.getByLabelText("Item") as HTMLInputElement;
const options = () => screen.queryAllByTestId("staple-suggestion");
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const press = (key: string) => fireEvent.keyDown(input(), { key });

describe("StapleCombobox", () => {
  it("has a visible label and no placeholder standing in for one", () => {
    render(<Harness />);
    // NN/g: the label goes above the field, and a placeholder must not do the
    // labelling — it vanishes exactly when the user needs it.
    expect(screen.getByText("Item").tagName).toBe("LABEL");
    expect(input().getAttribute("placeholder")).toBeNull();
  });

  it("suggests from the very first character", () => {
    render(<Harness />);
    expect(options()).toHaveLength(0);

    type("m");

    expect(options().length).toBeGreaterThan(0);
    expect(input().getAttribute("aria-expanded")).toBe("true");
  });

  it("shows nothing for an empty field", () => {
    render(<Harness />);
    type("m");
    expect(options().length).toBeGreaterThan(0);

    type("");

    expect(options()).toHaveLength(0);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("carries the ARIA combobox wiring", () => {
    render(<Harness />);
    type("mo");

    const el = input();
    expect(el.getAttribute("role")).toBe("combobox");
    expect(el.getAttribute("aria-autocomplete")).toBe("list");
    const listbox = screen.getByRole("listbox");
    expect(el.getAttribute("aria-controls")).toBe(listbox.id);
  });

  it("keeps DOM focus in the input while arrowing through options", () => {
    render(<Harness />);
    input().focus();
    type("mo");

    press("ArrowDown");

    // The single most important assertion in this file.
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0].id);
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
  });

  it("moves down and back up, and wraps at both ends", () => {
    render(<Harness />);
    type("mo");
    const count = options().length;
    expect(count).toBeGreaterThan(1);

    press("ArrowDown");
    press("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[1].id);

    press("ArrowUp");
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0].id);

    // Up from the first wraps to the last, so a thumb can reach either end.
    press("ArrowUp");
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[count - 1].id);
  });

  it("chooses the active option on Enter WITHOUT submitting the form", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    type("mo");
    press("ArrowDown");

    const chosen = options()[0].textContent;
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(input().value).toBe(chosen);
    expect(options()).toHaveLength(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits normally on Enter when no option is active", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    type("mo");

    // No arrow key pressed, so Enter is the user finishing their own text.
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(input().value).toBe("mo");
  });

  it("reports the chosen staple so the caller can prefill its unit", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    type("milk");
    press("ArrowDown");
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Milk", defaultUnit: "gal" }),
    );
  });

  it("dismisses on Escape without clearing what was typed", () => {
    render(<Harness />);
    type("mo");
    expect(options().length).toBeGreaterThan(0);

    press("Escape");

    expect(options()).toHaveLength(0);
    expect(input().value).toBe("mo");
    // Typing again brings the list back.
    type("mol");
    expect(options().length).toBeGreaterThan(0);
  });

  it("chooses an option on pointer down", () => {
    render(<Harness />);
    type("mo");
    const first = options()[0];
    const label = first.textContent;

    fireEvent.mouseDown(first);

    expect(input().value).toBe(label);
    expect(options()).toHaveLength(0);
  });

  it("bolds the typed text inside each suggestion", () => {
    render(<Harness />);
    type("mo");

    const strong = within(options()[0]).getByText("mo", { selector: "strong" });
    expect(strong).toBeTruthy();
    // …and the whole name is still readable, not just the bolded run.
    expect(options()[0].textContent).toBe("molasses");
  });

  it("announces the result count in a polite live region", () => {
    render(<Harness />);
    type("mo");

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toMatch(/^3 staples found\./);
  });

  it("announces nothing when there is nothing to announce", () => {
    render(<Harness />);
    type("zzz");

    expect(screen.getByRole("status").textContent).toBe("");
    expect(options()).toHaveLength(0);
  });
});
