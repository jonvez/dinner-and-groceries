import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BoardGrid, type ProposalView } from "./board-grid";

/**
 * The board renders a day x meal-type slot grid (dinner-focused) plus the
 * week's shared proposal pool (issue #8 acceptance criteria). Slotting itself is
 * #10 — these cells are empty placeholders, not drop targets.
 */

const proposals: ProposalView[] = [
  {
    id: "p1",
    title: "Carnitas Tacos",
    note: "family favorite",
    sourceUrl: "https://example.com/carnitas",
    proposerName: "Jon",
  },
  {
    id: "p2",
    title: "Caesar Salad",
    note: null,
    sourceUrl: null,
    proposerName: "Alex",
  },
];

function renderBoard(p: Partial<Parameters<typeof BoardGrid>[0]> = {}) {
  return render(
    <BoardGrid
      weekStart="2026-06-22"
      weekStartDay={1}
      proposals={proposals}
      {...p}
    />,
  );
}

describe("BoardGrid — slot grid", () => {
  it("renders all seven days from a Monday start, Mon first", () => {
    renderBoard();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers[0]).toContain("Mon");
    expect(headers[6]).toContain("Sun");
    expect(headers).toHaveLength(7);
  });

  it("renders the dinner meal-type row (model supports the others too)", () => {
    renderBoard();
    expect(screen.getByRole("rowheader", { name: /dinner/i })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: /breakfast/i })).toBeInTheDocument();
  });
});

describe("BoardGrid — proposal pool", () => {
  it("lists each proposal with its title, proposer and note", () => {
    renderBoard();
    const pool = screen.getByRole("region", { name: /idea/i });
    expect(within(pool).getByText("Carnitas Tacos")).toBeInTheDocument();
    expect(within(pool).getByText(/Jon/)).toBeInTheDocument();
    expect(within(pool).getByText(/family favorite/)).toBeInTheDocument();
    expect(within(pool).getByText("Caesar Salad")).toBeInTheDocument();
  });

  it("links a proposal that has a recipe URL", () => {
    renderBoard();
    const link = screen.getByRole("link", { name: /recipe/i });
    expect(link).toHaveAttribute("href", "https://example.com/carnitas");
  });

  it("shows an empty-state when there are no proposals yet", () => {
    renderBoard({ proposals: [] });
    const pool = screen.getByRole("region", { name: /idea/i });
    expect(within(pool).getByText(/no .*ideas|nothing|be the first/i)).toBeInTheDocument();
  });
});
