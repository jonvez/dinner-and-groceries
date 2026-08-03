import { describe, expect, it } from "vitest";

import { collectJsonLdNodes, isoDurationToMinutes } from "./recipe-jsonld";

describe("isoDurationToMinutes", () => {
  it("converts hours + minutes", () => {
    expect(isoDurationToMinutes("PT1H30M")).toBe(90);
    expect(isoDurationToMinutes("PT20M")).toBe(20);
    expect(isoDurationToMinutes("PT2H")).toBe(120);
  });
  it("rounds seconds into minutes", () => {
    expect(isoDurationToMinutes("PT1H0M30S")).toBe(61); // 60 + round(30/60)=1
  });
  it("returns null for empty, non-string, or unparseable input", () => {
    expect(isoDurationToMinutes("PT")).toBeNull();
    expect(isoDurationToMinutes("garbage")).toBeNull();
    expect(isoDurationToMinutes(null)).toBeNull();
    expect(isoDurationToMinutes(90)).toBeNull();
  });
});

describe("collectJsonLdNodes", () => {
  it("parses a single object block", () => {
    const html = `<script type="application/ld+json">{"@type":"Recipe","name":"A"}</script>`;
    const nodes = collectJsonLdNodes(html);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("A");
  });
  it("flattens arrays and @graph, and skips malformed blocks", () => {
    const html = `
      <script type="application/ld+json">{ not json }</script>
      <script type="application/ld+json">[{"@type":"Org","name":"O"},{"@type":"Recipe","name":"B"}]</script>
      <script type="application/ld+json">{"@graph":[{"@type":"Recipe","name":"C"}]}</script>`;
    const names = collectJsonLdNodes(html).map((n) => n.name).filter(Boolean);
    expect(names).toEqual(expect.arrayContaining(["O", "B", "C"]));
    // the malformed block contributes nothing
  });
});
