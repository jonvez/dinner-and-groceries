import { describe, expect, it } from "vitest";

import { countSteps, parseMethod, parseSpans } from "./method-parse";

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
    expect(phases.flatMap((p) => p.steps.map((s) => [s.n, s.body]))).toEqual([
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

  it("keeps an interior carriage return inside a step or note (parity with the SQL backfill)", () => {
    const [phase] = parseMethod("1. Sear\rthen flip.\n- Hot\rpan.");
    expect(phase.intro).toEqual([]);
    expect(phase.steps).toEqual([{ n: 1, body: "Sear\rthen flip.", notes: ["Hot\rpan."] }]);
  });
});

/**
 * ReDoS guard (the bug class of #176). Step bodies are stored text that any
 * household member can write, parsed on save and rendered (SSR) on every view,
 * so a quadratic regex here stalls the shared Node process for every
 * household. Each input is ~200k pathological chars; a linear regex handles it
 * in a few ms, a quadratic one takes many seconds.
 */
describe("method parsing is linear on hostile input", () => {
  const N = 200_000;
  const LIMIT_MS = 50;
  function timeMs(fn: () => unknown): number {
    const start = performance.now();
    fn();
    return performance.now() - start;
  }

  it("parseSpans: a long run of '['", () => {
    const text = "[".repeat(N);
    expect(timeMs(() => parseSpans(text))).toBeLessThan(LIMIT_MS);
  });

  it("parseMethod: a step marker, a long run of spaces, then an interior CR", () => {
    const text = `1. ${" ".repeat(N)}x\ry`;
    expect(timeMs(() => parseMethod(text))).toBeLessThan(LIMIT_MS);
  });

  it("parseMethod: a note marker, a long run of spaces, then an interior CR", () => {
    const text = `- ${" ".repeat(N)}x\ry`;
    expect(timeMs(() => parseMethod(text))).toBeLessThan(LIMIT_MS);
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

  it("does not make a chip of text containing '['", () => {
    expect(parseSpans("[[[[a]]")).toEqual([
      { kind: "text", text: "[[" },
      { kind: "ingredient", text: "a" },
    ]);
  });

  it("leaves markup-looking text alone (it is rendered as text, never HTML)", () => {
    expect(parseSpans("<img src=x onerror=alert(1)>")).toEqual([
      { kind: "text", text: "<img src=x onerror=alert(1)>" },
    ]);
  });
});
