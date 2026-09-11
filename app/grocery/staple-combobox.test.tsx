import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
    <>
      {/* Something outside the combobox to tap, like the page's heading. */}
      <h2>Groceries</h2>
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
        <label>
          Quantity
          <input name="quantity" />
        </label>
      </form>
    </>
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

/**
 * Leaving the list WITHOUT picking (#197). Since #185 the open list sits over
 * Quantity and Unit, and a phone keyboard has no Escape key, so the list must
 * close the way the APG combobox does: when focus leaves the input, and on a
 * press anywhere outside the input and its list. Neither may pick, and neither
 * may touch what was typed.
 */
describe("StapleCombobox — dismissing without picking (#197)", () => {
  /** A real focus move: the input gets a genuine `focusout`, not a fake one. */
  const leaveForQuantity = () =>
    act(() => screen.getByLabelText("Quantity").focus());

  it("closes when focus leaves the Item field, keeping what was typed", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    input().focus();
    type("mo");
    press("ArrowDown");
    expect(options().length).toBeGreaterThan(0);

    // Tab, the iOS accessory-bar arrows, or a tap on another field.
    leaveForQuantity();

    expect(options()).toHaveLength(0);
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    expect(input().value).toBe("mo");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("reopens when the user types again after leaving the field", () => {
    render(<Harness />);
    input().focus();
    type("mo");
    leaveForQuantity();
    expect(options()).toHaveLength(0);

    input().focus();
    type("mol");

    expect(options().length).toBeGreaterThan(0);
    // A fresh list: nothing highlighted until the user arrows.
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
  });

  it("closes on a press outside the combobox, without picking or clearing", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    input().focus();
    type("mo");
    // Even a HIGHLIGHTED option is not chosen by pressing elsewhere.
    press("ArrowDown");
    expect(options().length).toBeGreaterThan(0);

    fireEvent.pointerDown(screen.getByRole("heading", { name: "Groceries" }));

    expect(options()).toHaveLength(0);
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().value).toBe("mo");
    expect(onPick).not.toHaveBeenCalled();

    // Typing again brings it back, as after Escape.
    type("mol");
    expect(options().length).toBeGreaterThan(0);
  });

  it("stays open on a press on the input itself or inside the list", () => {
    render(<Harness />);
    input().focus();
    type("mo");
    const count = options().length;
    expect(count).toBeGreaterThan(0);

    fireEvent.pointerDown(input());
    expect(options()).toHaveLength(count);

    fireEvent.pointerDown(screen.getByRole("listbox"));
    expect(options()).toHaveLength(count);
  });

  it("never lets a press on the list blur the input, even between options", () => {
    render(<Harness />);
    input().focus();
    type("mo");

    // `fireEvent` returns false when the handler called preventDefault — the
    // browser's cue not to move focus. A press on the list's edge or padding
    // must not blur the input and so close the list under the finger.
    expect(fireEvent.mouseDown(screen.getByRole("listbox"))).toBe(false);
    expect(options().length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(input());
  });

  it("still picks on a tap: pointer-down then mouse-down on an option", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    input().focus();
    type("milk");
    const option = options()[0];

    // A real tap fires pointerdown before mousedown. The outside-press rule
    // must not close the list on the pointerdown, or there'd be nothing left
    // for the mousedown to pick.
    fireEvent.pointerDown(option);
    const notPrevented = fireEvent.mouseDown(option);

    expect(notPrevented).toBe(false); // so the input never blurs on the tap
    expect(input().value).toBe("Milk");
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Milk", defaultUnit: "gal" }),
    );
    expect(options()).toHaveLength(0);
    expect(document.activeElement).toBe(input());
  });
});
