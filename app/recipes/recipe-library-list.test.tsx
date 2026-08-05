import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RecipeLibraryList, type LibraryDish } from "./recipe-library-list";

/**
 * The read-only recipe library list (issue #12d): every saved dish, newest
 * first (ordering is the caller's responsibility — this component just
 * renders the array it's given), each linking to its /recipes/{id} detail
 * page (#12c), plus a friendly empty state and an always-present "Add a
 * recipe" entry point. No search/edit/delete/pagination in this brick.
 */

describe("RecipeLibraryList", () => {
  it("renders each saved dish as a link to its detail page, in the given order", () => {
    const dishes: LibraryDish[] = [
      { id: "d1", title: "Carnitas Tacos" },
      { id: "d2", title: "Skillet Chicken" },
    ];
    render(<RecipeLibraryList dishes={dishes} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Carnitas Tacos");
    expect(items[1]).toHaveTextContent("Skillet Chicken");

    expect(screen.getByRole("link", { name: "Carnitas Tacos" })).toHaveAttribute(
      "href",
      "/recipes/d1",
    );
    expect(screen.getByRole("link", { name: "Skillet Chicken" })).toHaveAttribute(
      "href",
      "/recipes/d2",
    );
  });

  it("shows a friendly empty state when there are no saved recipes", () => {
    render(<RecipeLibraryList dishes={[]} />);

    expect(screen.getByText(/haven.t saved any recipes yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("always shows the Add a recipe entry point, whether the library is empty or populated", () => {
    const { rerender } = render(<RecipeLibraryList dishes={[]} />);
    expect(screen.getByRole("link", { name: "Add a recipe" })).toHaveAttribute(
      "href",
      "/recipes/new",
    );

    rerender(<RecipeLibraryList dishes={[{ id: "d1", title: "Tacos" }]} />);
    expect(screen.getByRole("link", { name: "Add a recipe" })).toHaveAttribute(
      "href",
      "/recipes/new",
    );
  });

  it("renders a title containing markup as literal text, never as HTML", () => {
    const dishes: LibraryDish[] = [
      { id: "d1", title: "<img src=x onerror=alert(1)>Evil Recipe" },
    ];
    render(<RecipeLibraryList dishes={dishes} />);

    expect(
      screen.getByText("<img src=x onerror=alert(1)>Evil Recipe"),
    ).toBeInTheDocument();
    expect(document.querySelector("img")).not.toBeInTheDocument();
  });
});
