import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BoardGrid, type SlottedDishView } from "./board-grid";

/**
 * The board renders a day x meal-type SLOT GRID (dinner-focused; issue #8) and,
 * for issue #10, the dishes SLOTTED into each cell with a tap-to-unslot control.
 * The week's proposal POOL with its reactions/comments (issue #9) is rendered by
 * `ProposalPool`, tested separately in proposal-pool.test.tsx.
 */

// Unslot is a server action; stub it. The unslot orchestration is covered by
// slot-core.test.ts — here we only assert the chip + its control render.
vi.mock("./slot-actions", () => ({
  unslotDishAction: async () => null,
}));

function renderGrid(p: Partial<Parameters<typeof BoardGrid>[0]> = {}) {
  return render(<BoardGrid weekStart="2026-06-22" weekStartDay={1} {...p} />);
}

describe("BoardGrid — slot grid", () => {
  it("renders all seven days from a Monday start, Mon first", () => {
    renderGrid();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers[0]).toContain("Mon");
    expect(headers[6]).toContain("Sun");
    expect(headers).toHaveLength(7);
  });

  it("renders the dinner meal-type row (model supports the others too)", () => {
    renderGrid();
    expect(screen.getByRole("rowheader", { name: /dinner/i })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: /breakfast/i })).toBeInTheDocument();
  });
});

describe("BoardGrid — slotted dishes (issue #10)", () => {
  // 2026-06-22 is a Monday; Tuesday = day_of_week 2.
  const tuesdayDinner: SlottedDishView = {
    slotDishId: "sd1",
    dishId: "d1",
    title: "Spaghetti",
    dayOfWeek: 2,
    mealType: "dinner",
  };

  it("renders a slotted dish in its day + meal cell with an unslot control", () => {
    renderGrid({ slotted: [tuesdayDinner] });
    expect(screen.getByText("Spaghetti")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /unslot spaghetti/i }),
    ).toBeInTheDocument();
  });

  it("renders MANY dishes in one slot (composite meal: spaghetti + salad)", () => {
    renderGrid({
      slotted: [
        tuesdayDinner,
        {
          slotDishId: "sd2",
          dishId: "d2",
          title: "Caesar Salad",
          dayOfWeek: 2,
          mealType: "dinner",
        },
      ],
    });
    expect(screen.getByText("Spaghetti")).toBeInTheDocument();
    expect(screen.getByText("Caesar Salad")).toBeInTheDocument();
  });

  it("keeps an empty cell empty (a dish only shows in its own slot)", () => {
    renderGrid({ slotted: [tuesdayDinner] });
    // The same dish must NOT appear in the breakfast row.
    const breakfastRow = screen.getByRole("rowheader", {
      name: /breakfast/i,
    }).parentElement as HTMLElement;
    expect(within(breakfastRow).queryByText("Spaghetti")).not.toBeInTheDocument();
  });

  it("renders with no slotted prop (back-compat empty grid)", () => {
    renderGrid();
    expect(screen.queryByRole("button", { name: /unslot/i })).not.toBeInTheDocument();
  });
});
