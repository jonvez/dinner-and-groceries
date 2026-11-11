import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { IngredientGroups } from "./ingredient-groups";

describe("IngredientGroups", () => {
  it("renders a heading per named group with that group's lines under it", () => {
    render(
      <IngredientGroups
        groups={[
          { section: null, lines: ["1 lb rigatoni"] },
          { section: "Filling", lines: ["12 oz ricotta", "2 eggs"] },
          { section: "Topping", lines: ["1 cup red sauce"] },
        ]}
      />,
    );

    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Filling",
      "Topping",
    ]);
    const lists = screen.getAllByRole("list");
    expect(lists).toHaveLength(3);
    expect(within(lists[0]).getByText("1 lb rigatoni")).toBeInTheDocument();
    expect(within(lists[1]).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "12 oz ricotta",
      "2 eggs",
    ]);
    expect(within(lists[2]).getByText("1 cup red sauce")).toBeInTheDocument();
  });

  it("renders an ungrouped list with no headings", () => {
    render(<IngredientGroups groups={[{ section: null, lines: ["2 cups flour", "1 tsp salt"] }]} />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByText("2 cups flour")).toBeInTheDocument();
  });

  it("says so when there are no ingredients", () => {
    render(<IngredientGroups groups={[]} />);
    expect(screen.getByText("No ingredients yet.")).toBeInTheDocument();
  });
});
