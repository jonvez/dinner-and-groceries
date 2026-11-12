import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecipeMethod } from "./method";
import type { MethodPhase } from "./method-types";

const PHASES: MethodPhase[] = [
  {
    title: "Start",
    intro: [],
    steps: [
      {
        id: "s1",
        n: 1,
        body: "Into the pot: [[1 qt stock]] [[2 bay leaves]]",
        notes: ["**No salt** yet."],
      },
      { id: "s2", n: 2, body: "Simmer.", notes: [] },
    ],
  },
  {
    title: "Finish",
    intro: ["Off the heat from here."],
    steps: [{ id: "s3", n: 3, body: "Add [[the lime juice]].", notes: [] }],
  },
];

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
    render(<RecipeMethod phases={PHASES} dishId="d1" />);

    expect(screen.getByRole("heading", { name: "Start" })).toBeInTheDocument();
    expect(screen.getByText("Off the heat from here.")).toBeInTheDocument();
    expect(screen.getByText("1 qt stock")).toBeInTheDocument();
    expect(screen.getByText("2 bay leaves")).toBeInTheDocument();
    expect(screen.getByText("No salt")).toBeInTheDocument();
    const last = screen.getAllByRole("button").find((b) => b.textContent?.includes("the lime juice"));
    expect(last).toHaveTextContent(/^3Add the lime juice\.$/);
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
  });

  it("hints that steps are tappable until the first one is done", () => {
    render(<RecipeMethod phases={PHASES} dishId="d1" />);
    expect(screen.getByText("Tap a step when it’s done")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Into the pot/ }));

    expect(screen.queryByText("Tap a step when it’s done")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jump to current" })).toBeInTheDocument();
  });

  it("marks a step done, advances to the next, and scrolls it into view", () => {
    render(<RecipeMethod phases={PHASES} dishId="d1" />);

    const first = screen.getByRole("button", { name: /Into the pot/ });
    fireEvent.click(first);

    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("persists progress per dish, keyed by step id, and restores it on a fresh render", () => {
    const { unmount } = render(<RecipeMethod phases={PHASES} dishId="d1" />);
    fireEvent.click(screen.getByRole("button", { name: /Into the pot/ }));
    unmount();

    render(<RecipeMethod phases={PHASES} dishId="d1" />);
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("cook-progress:v2:d1") ?? "[]")).toEqual(["s1"]);
    expect(localStorage.getItem("cook-progress:v2:d2")).toBeNull();
  });

  it("ignores the spike's old number-keyed progress (a fresh start)", () => {
    localStorage.setItem("cook-progress:d1", "[1,2]");
    render(<RecipeMethod phases={PHASES} dishId="d1" />);
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
  });

  it("keeps a done step done when an edit inserts a new step before it", () => {
    const { rerender } = render(<RecipeMethod phases={PHASES} dishId="d1" />);
    fireEvent.click(screen.getByRole("button", { name: /Simmer/ }));

    // The recipe is revised mid-cook: a new first step, everything renumbers.
    const edited: MethodPhase[] = [
      {
        ...PHASES[0],
        steps: [
          { id: "s0", n: 1, body: "Oven on.", notes: [] },
          { ...PHASES[0].steps[0], n: 2 },
          { ...PHASES[0].steps[1], n: 3 },
        ],
      },
      { ...PHASES[1], steps: [{ ...PHASES[1].steps[0], n: 4 }] },
    ];
    rerender(<RecipeMethod phases={edited} dishId="d1" />);

    const simmer = screen.getByRole("button", { name: /Simmer/ });
    expect(simmer).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Into the pot/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByText("Step 1 of 4")).toBeInTheDocument();
  });

  it("un-marks a done step on a second tap, and Reset clears everything", () => {
    render(<RecipeMethod phases={PHASES} dishId="d1" />);
    const first = screen.getByRole("button", { name: /Into the pot/ });

    fireEvent.click(first);
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: /Simmer/ }));
    window.scrollTo = vi.fn();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(localStorage.getItem("cook-progress:v2:d1")).toBeNull();
  });

  it("renders stored markup as text, never as HTML", () => {
    const { container } = render(
      <RecipeMethod
        phases={[
          {
            title: "",
            intro: [],
            steps: [{ id: "x", n: 1, body: "<img src=x onerror=alert(1)>", notes: [] }],
          },
        ]}
        dishId="d1"
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });
});
