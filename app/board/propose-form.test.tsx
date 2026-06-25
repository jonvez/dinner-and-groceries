import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The form imports the "use server" actions module, which pulls in next/headers
// etc. Mock it so the client component renders in jsdom (we assert the UI shape;
// the action contract is covered by actions-core.test.ts).
vi.mock("./actions", () => ({
  proposeNewDishAction: vi.fn(async () => null),
  recycleDishAction: vi.fn(async () => null),
}));

import { ProposeForm } from "./propose-form";

describe("ProposeForm — new dish", () => {
  it("offers title, recipe URL and note fields plus a propose button", () => {
    render(<ProposeForm weekStart="2026-06-22" libraryDishes={[]} />);

    expect(screen.getByLabelText(/dish|title/i)).toBeRequired();
    expect(screen.getByLabelText(/recipe url|link/i)).not.toBeRequired();
    expect(screen.getByLabelText(/note/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /propose dish|add dish/i }),
    ).toBeInTheDocument();
  });

  it("carries the week start so the proposal lands on the viewed week", () => {
    const { container } = render(
      <ProposeForm weekStart="2026-06-22" libraryDishes={[]} />,
    );
    const hidden = container.querySelector('input[name="weekStart"]');
    expect(hidden).toHaveValue("2026-06-22");
  });
});

describe("ProposeForm — recycle existing dish", () => {
  it("lets you propose an existing library dish again", () => {
    render(
      <ProposeForm
        weekStart="2026-06-22"
        libraryDishes={[
          { id: "d1", title: "Carnitas Tacos" },
          { id: "d2", title: "Caesar Salad" },
        ]}
      />,
    );

    const select = screen.getByLabelText(/propose again|existing dish|from your library/i);
    expect(select).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Carnitas Tacos" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /propose again/i }),
    ).toBeInTheDocument();
  });

  it("hides the recycle control when the library is empty", () => {
    render(<ProposeForm weekStart="2026-06-22" libraryDishes={[]} />);
    expect(
      screen.queryByRole("button", { name: /propose again/i }),
    ).not.toBeInTheDocument();
  });
});
