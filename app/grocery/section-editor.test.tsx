import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SectionEditor } from "./section-editor";
import type { SectionRow } from "./sections-core";

/**
 * The aisle editor (#138). Setting up the store's layout is a sit-down task, so
 * it lives collapsed under the list rather than competing with it mid-shop.
 *
 * What's pinned here:
 *   - reordering is BUTTONS, not drag: the issue requires a keyboard path, and
 *     drag on a scrolling phone list is hostile even with a mouse;
 *   - every edit is optimistic and ROLLS BACK on failure, so a bad signal in a
 *     store can't leave the aisles silently wrong;
 *   - deleting takes two taps and says what happens to the items, because the
 *     button sits one thumb-width from the list someone is shopping.
 */

type Result = { ok: true } | { ok: false; error: string };

const actions = vi.hoisted(() => ({
  create: vi.fn<(name: string) => Promise<Result>>(async () => ({ ok: true })),
  rename: vi.fn<(id: string, name: string) => Promise<Result>>(async () => ({ ok: true })),
  reorder: vi.fn<(ids: string[]) => Promise<Result>>(async () => ({ ok: true })),
  remove: vi.fn<(id: string) => Promise<Result>>(async () => ({ ok: true })),
}));

vi.mock("./actions", () => ({
  createSectionAction: (name: string) => actions.create(name),
  renameSectionAction: (id: string, name: string) => actions.rename(id, name),
  reorderSectionsAction: (ids: string[]) => actions.reorder(ids),
  deleteSectionAction: (id: string) => actions.remove(id),
}));

const SECTIONS: SectionRow[] = [
  { id: "s1", name: "Produce", position: 10 },
  { id: "s2", name: "Dairy & Eggs", position: 20 },
  { id: "s3", name: "Unsorted", position: 110 },
];

beforeEach(() => {
  for (const fn of Object.values(actions)) {
    fn.mockClear();
    fn.mockImplementation(async () => ({ ok: true }));
  }
});

/**
 * The editor is CONTROLLED — `GroceryList` owns `sections` so the grouped list
 * re-renders the moment an aisle moves. The harness has to own it the same way,
 * or an optimistic edit would have nowhere to land.
 */
function Harness({
  sections,
  onChange,
}: {
  sections: SectionRow[];
  onChange: (next: SectionRow[]) => void;
}) {
  const [current, setCurrent] = useState(sections);
  return (
    <SectionEditor
      sections={current}
      onSectionsChange={(next) => {
        setCurrent(next);
        onChange(next);
      }}
    />
  );
}

/** Render with the panel already open — it starts collapsed in the app. */
function renderEditor(sections: SectionRow[] = SECTIONS) {
  const onSectionsChange = vi.fn();
  const view = render(
    <Harness sections={sections} onChange={onSectionsChange} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /edit aisles/i }));
  return { ...view, onSectionsChange };
}

const aisleNames = () =>
  screen.getAllByTestId("aisle-row").map((el) => el.dataset.name);

const aisle = (name: string) =>
  screen.getAllByTestId("aisle-row").find((el) => el.dataset.name === name)!;

const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

describe("SectionEditor", () => {
  it("stays collapsed until asked for — the list is what matters mid-shop", () => {
    render(<SectionEditor sections={SECTIONS} onSectionsChange={vi.fn()} />);

    const toggle = screen.getByRole("button", { name: /edit aisles/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByTestId("aisle-row")).toHaveLength(0);
  });

  it("lists the aisles in order once opened", () => {
    renderEditor();

    expect(aisleNames()).toEqual(["Produce", "Dairy & Eggs", "Unsorted"]);
  });

  it("moves an aisle up and saves the new order", async () => {
    const { onSectionsChange } = renderEditor();

    await click(within(aisle("Dairy & Eggs")).getByRole("button", { name: "Move Dairy & Eggs up" }));

    expect(aisleNames()).toEqual(["Dairy & Eggs", "Produce", "Unsorted"]);
    expect(actions.reorder).toHaveBeenCalledWith(["s2", "s1", "s3"]);
    // The list above re-groups immediately, without waiting for the server.
    expect(onSectionsChange).toHaveBeenCalled();
  });

  it("moves an aisle down and saves the new order", async () => {
    renderEditor();

    await click(within(aisle("Produce")).getByRole("button", { name: "Move Produce down" }));

    expect(aisleNames()).toEqual(["Dairy & Eggs", "Produce", "Unsorted"]);
    expect(actions.reorder).toHaveBeenCalledWith(["s2", "s1", "s3"]);
  });

  it("cannot move the first aisle up or the last one down", () => {
    renderEditor();

    expect(
      within(aisle("Produce")).getByRole("button", { name: "Move Produce up" }),
    ).toBeDisabled();
    expect(
      within(aisle("Unsorted")).getByRole("button", { name: "Move Unsorted down" }),
    ).toBeDisabled();
  });

  it("puts the order back and reports the error when a reorder fails", async () => {
    actions.reorder.mockImplementation(async () => ({
      ok: false,
      error: "Could not update the sections.",
    }));
    renderEditor();

    await click(within(aisle("Produce")).getByRole("button", { name: "Move Produce down" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Could not update the sections.",
      ),
    );
    expect(aisleNames()).toEqual(["Produce", "Dairy & Eggs", "Unsorted"]);
  });

  it("renames an aisle through an inline form", async () => {
    renderEditor();

    await click(within(aisle("Produce")).getByRole("button", { name: "Rename Produce" }));
    const input = screen.getByLabelText("New name for Produce");
    fireEvent.change(input, { target: { value: "Fruit & Veg" } });
    await click(screen.getByRole("button", { name: "Save" }));

    expect(actions.rename).toHaveBeenCalledWith("s1", "Fruit & Veg");
    expect(aisleNames()).toEqual(["Fruit & Veg", "Dairy & Eggs", "Unsorted"]);
  });

  it("abandons a rename on cancel, writing nothing", async () => {
    renderEditor();

    await click(within(aisle("Produce")).getByRole("button", { name: "Rename Produce" }));
    fireEvent.change(screen.getByLabelText("New name for Produce"), {
      target: { value: "Nope" },
    });
    await click(screen.getByRole("button", { name: "Cancel" }));

    expect(actions.rename).not.toHaveBeenCalled();
    expect(aisleNames()).toEqual(["Produce", "Dairy & Eggs", "Unsorted"]);
  });

  it("takes two taps to delete, and says where the items go", async () => {
    renderEditor();

    await click(within(aisle("Produce")).getByRole("button", { name: "Delete Produce" }));
    // Nothing written yet — the first tap only arms the confirmation.
    expect(actions.remove).not.toHaveBeenCalled();
    const confirm = within(aisle("Produce")).getByRole("button", {
      name: /delete produce\?/i,
    });
    expect(within(aisle("Produce")).getByText(/move to Unsorted/i)).toBeTruthy();

    await click(confirm);

    expect(actions.remove).toHaveBeenCalledWith("s1");
    expect(aisleNames()).toEqual(["Dairy & Eggs", "Unsorted"]);
  });

  it("restores a deleted aisle when the write fails", async () => {
    actions.remove.mockImplementation(async () => ({
      ok: false,
      error: "Could not update the sections.",
    }));
    renderEditor();

    await click(within(aisle("Produce")).getByRole("button", { name: "Delete Produce" }));
    await click(
      within(aisle("Produce")).getByRole("button", { name: /delete produce\?/i }),
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(aisleNames()).toEqual(["Produce", "Dairy & Eggs", "Unsorted"]);
  });

  it("adds an aisle and clears the field", async () => {
    renderEditor();

    const input = screen.getByLabelText("New aisle");
    fireEvent.change(input, { target: { value: "  Bulk bins  " } });
    await click(screen.getByRole("button", { name: "Add aisle" }));

    expect(actions.create).toHaveBeenCalledWith("Bulk bins");
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("does not write a blank aisle", async () => {
    renderEditor();

    fireEvent.change(screen.getByLabelText("New aisle"), { target: { value: "   " } });
    await click(screen.getByRole("button", { name: "Add aisle" }));

    expect(actions.create).not.toHaveBeenCalled();
  });
});
