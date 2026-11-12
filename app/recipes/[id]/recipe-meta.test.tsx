import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RecipeMeta } from "./recipe-meta";

describe("RecipeMeta", () => {
  it("shows the times and the servings side by side", () => {
    render(<RecipeMeta prepMinutes={10} cookMinutes={60} totalMinutes={null} servings="6 to 8" />);

    expect(screen.getByText("Prep")).toBeInTheDocument();
    expect(screen.getByText("10 min")).toBeInTheDocument();
    expect(screen.getByText("Cook")).toBeInTheDocument();
    expect(screen.queryByText("Total")).not.toBeInTheDocument();
    expect(screen.getByText("Serves")).toBeInTheDocument();
    expect(screen.getByText("6 to 8")).toBeInTheDocument();
  });

  it("shows servings alone when there are no times", () => {
    render(<RecipeMeta prepMinutes={null} cookMinutes={null} totalMinutes={null} servings="4" />);
    expect(screen.getByText("Serves")).toBeInTheDocument();
    expect(screen.queryByText("Prep")).not.toBeInTheDocument();
  });

  it("renders nothing when there is nothing to show", () => {
    const { container } = render(
      <RecipeMeta prepMinutes={null} cookMinutes={null} totalMinutes={null} servings={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
