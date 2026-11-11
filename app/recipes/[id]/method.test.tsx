import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecipeMethod } from "./method";

const METHOD = [
  "## Start",
  "1. Into the pot: [[1 qt stock]] [[2 bay leaves]]",
  "- **No salt** yet.",
  "2. Simmer.",
  "## Finish",
  "1. Add [[the lime juice]].",
].join("\n");

describe("RecipeMethod (cook mode)", () => {
  beforeEach(() => {
    localStorage.clear();
    // jsdom implements neither; the component calls both when advancing.
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows each step with its ingredients inline, numbered across phases", () => {
    render(<RecipeMethod method={METHOD} dishId="d1" />);

    expect(screen.getByRole("heading", { name: "Start" })).toBeInTheDocument();
    expect(screen.getByText("1 qt stock")).toBeInTheDocument();
    expect(screen.getByText("2 bay leaves")).toBeInTheDocument();
    expect(screen.getByText("No salt")).toBeInTheDocument();
    const last = screen.getAllByRole("button").find((b) => b.textContent?.includes("the lime juice"));
    expect(last).toHaveTextContent(/^3Add the lime juice\.$/);
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
  });

  it("hints that steps are tappable until the first one is done", () => {
    render(<RecipeMethod method={METHOD} dishId="d1" />);
    expect(screen.getByText("Tap a step when it’s done")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Into the pot/ }));

    expect(screen.queryByText("Tap a step when it’s done")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jump to current" })).toBeInTheDocument();
  });

  it("marks a step done, advances to the next, and scrolls it into view", () => {
    render(<RecipeMethod method={METHOD} dishId="d1" />);

    const first = screen.getByRole("button", { name: /Into the pot/ });
    fireEvent.click(first);

    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("persists progress per dish and restores it on a fresh render", () => {
    const { unmount } = render(<RecipeMethod method={METHOD} dishId="d1" />);
    fireEvent.click(screen.getByRole("button", { name: /Into the pot/ }));
    unmount();

    render(<RecipeMethod method={METHOD} dishId="d1" />);
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("cook-progress:d1") ?? "[]")).toEqual([1]);
    expect(localStorage.getItem("cook-progress:d2")).toBeNull();
  });

  it("un-marks a done step on a second tap, and Reset clears everything", () => {
    render(<RecipeMethod method={METHOD} dishId="d1" />);
    const first = screen.getByRole("button", { name: /Into the pot/ });

    fireEvent.click(first);
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: /Simmer/ }));
    window.scrollTo = vi.fn();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(localStorage.getItem("cook-progress:d1")).toBeNull();
  });

  it("renders stored markup as text, never as HTML", () => {
    const { container } = render(
      <RecipeMethod method={"1. <img src=x onerror=alert(1)>"} dishId="d1" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });
});
