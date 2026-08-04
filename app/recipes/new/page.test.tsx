import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/recipes/new" }));
vi.mock("./actions", () => ({
  fetchRecipePreviewAction: vi.fn(async () => null),
  saveIngestedDishAction: vi.fn(async () => null),
}));

import NewRecipePage from "./page";

describe("NewRecipePage", () => {
  it("renders the global nav, a heading, and the ingest form", () => {
    render(<NewRecipePage />);
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /add a recipe/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Recipe URL")).toBeInTheDocument();
  });
});
