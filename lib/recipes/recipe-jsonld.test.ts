import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectJsonLdNodes,
  decodeEntities,
  extractRecipeJsonLd,
  findRecipeNode,
  firstImageUrl,
  isoDurationToMinutes,
} from "./recipe-jsonld";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name), "utf8");

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

describe("findRecipeNode", () => {
  it("matches @type as a string or an array, else null", () => {
    expect(findRecipeNode([{ "@type": "Article" }])).toBeNull();
    expect(findRecipeNode([{ "@type": "Recipe", name: "X" }])?.name).toBe("X");
    expect(findRecipeNode([{ "@type": ["Thing", "Recipe"], name: "Y" }])?.name).toBe("Y");
    expect(findRecipeNode([{ "@type": "http://schema.org/Recipe", name: "Z" }])?.name).toBe("Z");
  });
  it("returns the first Recipe when several exist", () => {
    const first = findRecipeNode([{ "@type": "Recipe", name: "first" }, { "@type": "Recipe", name: "second" }]);
    expect(first?.name).toBe("first");
  });
});

describe("firstImageUrl", () => {
  it("handles string, {url}, and array", () => {
    expect(firstImageUrl("https://a/x.jpg")).toBe("https://a/x.jpg");
    expect(firstImageUrl({ url: "https://a/y.jpg" })).toBe("https://a/y.jpg");
    expect(firstImageUrl(["https://a/z1.jpg", "https://a/z2.jpg"])).toBe("https://a/z1.jpg");
    expect(firstImageUrl([{ url: "https://a/o.jpg" }])).toBe("https://a/o.jpg");
    expect(firstImageUrl(undefined)).toBeNull();
  });
});

describe("decodeEntities", () => {
  it("decodes the common named + numeric entities", () => {
    expect(decodeEntities("rice &amp; beans")).toBe("rice & beans");
    expect(decodeEntities("&frac12; cup")).toBe("½ cup");
    expect(decodeEntities("2 &#39;big&#39; eggs")).toBe("2 'big' eggs");
    expect(decodeEntities("&#188; tsp")).toBe("¼ tsp");
  });
});

describe("extractRecipeJsonLd", () => {
  it("extracts a single-object recipe with times, image, ingredients", () => {
    const r = extractRecipeJsonLd(fixture("single-recipe.html"))!;
    expect(r.title).toBe("Carnitas Tacos");
    expect(r.imageUrl).toBe("https://example.com/tacos.jpg");
    expect(r.prepMinutes).toBe(20);
    expect(r.cookMinutes).toBe(90);
    expect(r.totalMinutes).toBe(110);
    expect(r.ingredientLines).toEqual([
      "2 lb pork shoulder",
      "1 tbsp ground cumin",
      "3 corn tortillas",
    ]);
  });

  it("finds a Recipe inside @graph with @type array + image object", () => {
    const r = extractRecipeJsonLd(fixture("graph.html"))!;
    expect(r.title).toBe("Graph Soup");
    expect(r.imageUrl).toBe("https://example.com/soup.jpg");
    expect(r.totalMinutes).toBe(45);
    expect(r.ingredientLines).toEqual(["1 onion, diced", "2 cups vegetable broth"]);
  });

  it("handles a top-level array, legacy `ingredients`, and image array", () => {
    const r = extractRecipeJsonLd(fixture("array-types.html"))!;
    expect(r.title).toBe("Array Stew");
    expect(r.imageUrl).toBe("https://example.com/stew1.jpg");
    expect(r.ingredientLines).toEqual(["3 carrots", "1 lb beef chuck"]);
  });

  it("returns null when there is no Recipe block", () => {
    expect(extractRecipeJsonLd(fixture("no-recipe.html"))).toBeNull();
  });

  it("skips a malformed block, recovers the Recipe, and decodes entities", () => {
    const r = extractRecipeJsonLd(fixture("malformed.html"))!;
    expect(r.title).toBe("Recovered & Tasty");
    expect(r.ingredientLines).toEqual(["1 cup rice & beans", "½ tsp salt"]);
  });

  it("returns null for HTML with no JSON-LD at all", () => {
    expect(extractRecipeJsonLd("<html><body>nope</body></html>")).toBeNull();
  });
});
