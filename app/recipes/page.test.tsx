import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/recipes" }));

import RecipesPage from "./page";

describe("RecipesPage shell", () => {
  it("renders the global nav and a Recipes heading", () => {
    render(<RecipesPage />);
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recipes" })).toBeInTheDocument();
  });
});
