import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BoardGrid } from "./board-grid";

/**
 * The board renders a day x meal-type SLOT GRID (dinner-focused; issue #8). The
 * cells are empty placeholders — slotting is #10. The week's proposal POOL with
 * its reactions/comments (issue #9) is rendered by `ProposalPool`, tested
 * separately in proposal-pool.test.tsx.
 */

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
