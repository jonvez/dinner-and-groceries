import { describe, expect, it } from "vitest";

import { countSteps, currentStep, parseMethod, parseProgress, parseSpans } from "./method-parse";

describe("parseMethod", () => {
  it("groups steps into phases and numbers them across the whole method", () => {
    const phases = parseMethod(
      [
        "## Start the pork",
        "1. Cube the pork.",
        "2. Into the pot.",
        "",
        "## While it simmers",
        "Prep what comes later.",
        "1. Dice the onion.",
      ].join("\n"),
    );

    expect(phases.map((p) => p.title)).toEqual(["Start the pork", "While it simmers"]);
    expect(phases[1].intro).toEqual(["Prep what comes later."]);
    // The author restarted at "1."; the cook sees one continuous count.
    expect(phases.flatMap((p) => p.steps.map((s) => [s.n, s.text]))).toEqual([
      [1, "Cube the pork."],
      [2, "Into the pot."],
      [3, "Dice the onion."],
    ]);
    expect(countSteps(phases)).toBe(3);
  });

  it("attaches bullets to the step above, or to the phase when it has no step yet", () => {
    const [phase] = parseMethod(
      ["## Leftovers", "- Store the rice separately.", "1. Reheat.", "- Add fresh lime."].join(
        "\n",
      ),
    );

    expect(phase.intro).toEqual(["Store the rice separately."]);
    expect(phase.steps[0].notes).toEqual(["Add fresh lime."]);
  });

  it("puts steps before any heading into an untitled phase", () => {
    const phases = parseMethod("1. Boil water.\n2. Add pasta.");
    expect(phases).toHaveLength(1);
    expect(phases[0].title).toBe("");
    expect(countSteps(phases)).toBe(2);
  });

  it("returns no phases for blank text", () => {
    expect(parseMethod("  \n\n")).toEqual([]);
  });
});

describe("parseSpans", () => {
  it("splits ingredient chips and emphasis out of plain text", () => {
    expect(parseSpans("Add [[2 cups broth]], then **skim**.")).toEqual([
      { kind: "text", text: "Add " },
      { kind: "ingredient", text: "2 cups broth" },
      { kind: "text", text: ", then " },
      { kind: "strong", text: "skim" },
      { kind: "text", text: "." },
    ]);
  });

  it("leaves markup-looking text alone (it is rendered as text, never HTML)", () => {
    expect(parseSpans("<img src=x onerror=alert(1)>")).toEqual([
      { kind: "text", text: "<img src=x onerror=alert(1)>" },
    ]);
  });
});

describe("currentStep", () => {
  it("is the first step not yet done, even if later steps are done", () => {
    expect(currentStep(4, new Set([1, 3]))).toBe(2);
  });

  it("is null once every step is done", () => {
    expect(currentStep(2, new Set([1, 2]))).toBeNull();
  });
});

describe("parseProgress", () => {
  it("reads a saved list of step numbers", () => {
    expect(parseProgress("[1,2,5]")).toEqual(new Set([1, 2, 5]));
  });

  it("treats missing or malformed storage as a fresh start", () => {
    expect(parseProgress(null)).toEqual(new Set());
    expect(parseProgress("not json")).toEqual(new Set());
    expect(parseProgress('{"a":1}')).toEqual(new Set());
    expect(parseProgress('[1,"2",3.5,4]')).toEqual(new Set([1, 4]));
  });
});
