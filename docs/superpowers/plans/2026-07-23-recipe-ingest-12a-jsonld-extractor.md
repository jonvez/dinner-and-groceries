# 12a — JSON-LD recipe extractor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure, framework-free function that extracts a `schema.org/Recipe` from an HTML string into a structured `{ title, imageUrl, ingredientLines, prep/cook/total minutes }`, or `null` when no Recipe is present.

**Architecture:** Bottom-up pure helpers (`isoDurationToMinutes`, `collectJsonLdNodes`, `findRecipeNode`, `firstImageUrl`, `decodeEntities`) assembled by `extractRecipeJsonLd`. Takes HTML **as a string** — deliberately decoupled from the fetcher (#76) so #77's saved-HTML path reuses it for free. No network, no DOM, no Supabase.

**Tech Stack:** TypeScript, Vitest. Zero runtime dependencies.

## Global Constraints

- **Design of record:** `docs/superpowers/specs/2026-07-22-recipe-ingest-design.md`, section "12a — JSON-LD recipe extractor". Shapes handled / skipped are enumerated there and below — do not add microdata/RDFa, multi-recipe, or network I/O.
- **File:** `lib/recipes/recipe-jsonld.ts` (+ `lib/recipes/recipe-jsonld.test.ts`, + fixtures under `lib/recipes/fixtures/`). Match the house style of the sibling `lib/recipes/ingredient.ts` (framework-free, doc-commented, pure).
- **Public API (exact):**
  ```ts
  export type ExtractedRecipe = {
    title: string | null;
    imageUrl: string | null;
    ingredientLines: string[];
    prepMinutes: number | null;
    cookMinutes: number | null;
    totalMinutes: number | null;
  };
  export function isoDurationToMinutes(iso: unknown): number | null;
  export function collectJsonLdNodes(html: string): Record<string, unknown>[];
  export function findRecipeNode(nodes: Record<string, unknown>[]): Record<string, unknown> | null;
  export function firstImageUrl(image: unknown): string | null;
  export function decodeEntities(text: string): string;
  export function extractRecipeJsonLd(html: string): ExtractedRecipe | null;
  ```
- **Ingredient lines are raw** (pre-normalization) — this brick does NOT call `parseIngredient` (that happens in 12c on save). Just return the cleaned string array.
- Node `runtime` is irrelevant — this is a pure lib with no I/O.
- Conventional commits (`feat:`), TDD, frequent commits. All changes route through a PR (branch protection).

## File Structure

- `lib/recipes/recipe-jsonld.ts` — **create.** All helpers + the public `extractRecipeJsonLd`.
- `lib/recipes/recipe-jsonld.test.ts` — **create.** Unit tests (helpers + fixture-driven integration).
- `lib/recipes/fixtures/*.html` — **create.** Six saved-HTML fixtures (Task 4).

---

### Task 1: `isoDurationToMinutes`

**Files:**
- Create: `lib/recipes/recipe-jsonld.ts`
- Test: `lib/recipes/recipe-jsonld.test.ts`

**Interfaces:**
- Produces: `isoDurationToMinutes(iso: unknown): number | null` — used by `extractRecipeJsonLd` (Task 4).

- [ ] **Step 1: Write the failing test**

```ts
// lib/recipes/recipe-jsonld.test.ts
import { describe, expect, it } from "vitest";

import { isoDurationToMinutes } from "./recipe-jsonld";

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/recipes/recipe-jsonld.test.ts`
Expected: FAIL — module/export not found.

- [ ] **Step 3: Implement (create the file with the header + this helper)**

```ts
// lib/recipes/recipe-jsonld.ts
/**
 * Framework-free schema.org/Recipe extractor (issue #12a, Slice 1c). Takes raw
 * HTML as a STRING (decoupled from the fetcher so a saved-HTML paste, #77, reuses
 * it) and returns a structured recipe, or null when no Recipe JSON-LD is present.
 * Pure: no network, no DOM, no Supabase. Ingredient lines are returned RAW —
 * normalization (parseIngredient) happens on save in #12c.
 *
 * Scope (spec 12a): JSON-LD only (no microdata/RDFa); handles a single object, an
 * array, and the @graph wrapper; @type as string or array; recipeIngredient with a
 * legacy `ingredients` fallback; ISO-8601 durations → minutes; image as string,
 * {url}, or array. Takes the FIRST Recipe found.
 */

export type ExtractedRecipe = {
  title: string | null;
  imageUrl: string | null;
  ingredientLines: string[];
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
};

// Only the time components (H/M/S) are counted; any date part (Y/M/W/D) is ignored
// — recipe durations are sub-day in practice.
const ISO_DURATION_RE =
  /^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function isoDurationToMinutes(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const match = iso.trim().match(ISO_DURATION_RE);
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  if (hours === undefined && minutes === undefined && seconds === undefined) {
    return null;
  }
  return (
    (hours ? Number(hours) * 60 : 0) +
    (minutes ? Number(minutes) : 0) +
    (seconds ? Math.round(Number(seconds) / 60) : 0)
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/recipes/recipe-jsonld.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/recipes/recipe-jsonld.ts lib/recipes/recipe-jsonld.test.ts
git commit -m "feat(recipes): ISO-8601 duration → minutes for JSON-LD extractor (#12a)"
```

---

### Task 2: `collectJsonLdNodes` — parse + flatten all JSON-LD blocks

**Files:**
- Modify: `lib/recipes/recipe-jsonld.ts`
- Test: `lib/recipes/recipe-jsonld.test.ts`

**Interfaces:**
- Produces: `collectJsonLdNodes(html: string): Record<string, unknown>[]` — every JSON-LD object on the page, with arrays and `@graph` wrappers flattened, malformed blocks skipped. Consumed by `findRecipeNode` (Task 3) / `extractRecipeJsonLd` (Task 4).

- [ ] **Step 1: Write the failing test** (append to the test file)

```ts
import { collectJsonLdNodes } from "./recipe-jsonld";

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/recipes/recipe-jsonld.test.ts -t collectJsonLdNodes`
Expected: FAIL — `collectJsonLdNodes` not exported.

- [ ] **Step 3: Implement (append to `recipe-jsonld.ts`)**

```ts
const JSONLD_SCRIPT_RE =
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Expand a parsed JSON-LD value into candidate nodes (arrays + @graph inlined). */
function flattenNodes(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flattenNodes);
  if (value && typeof value === "object") {
    const graph = (value as Record<string, unknown>)["@graph"];
    if (Array.isArray(graph)) return [value, ...graph.flatMap(flattenNodes)];
    return [value];
  }
  return [value];
}

export function collectJsonLdNodes(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  for (const match of html.matchAll(JSONLD_SCRIPT_RE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue; // one malformed block must not sink the whole page
    }
    for (const node of flattenNodes(parsed)) {
      if (node && typeof node === "object" && !Array.isArray(node)) {
        nodes.push(node as Record<string, unknown>);
      }
    }
  }
  return nodes;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/recipes/recipe-jsonld.test.ts`
Expected: PASS (all tests so far).

- [ ] **Step 5: Commit**

```bash
git add lib/recipes/recipe-jsonld.ts lib/recipes/recipe-jsonld.test.ts
git commit -m "feat(recipes): collect + flatten JSON-LD script blocks (#12a)"
```

---

### Task 3: `findRecipeNode`, `firstImageUrl`, `decodeEntities`

**Files:**
- Modify: `lib/recipes/recipe-jsonld.ts`
- Test: `lib/recipes/recipe-jsonld.test.ts`

**Interfaces:**
- Produces:
  - `findRecipeNode(nodes): Record<string, unknown> | null` — first node whose `@type` (string or array) is `Recipe` (or `.../Recipe`).
  - `firstImageUrl(image): string | null` — image as string, `{ url }`, or array of those.
  - `decodeEntities(text): string` — decode the common HTML entities that survive JSON parsing.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { decodeEntities, findRecipeNode, firstImageUrl } from "./recipe-jsonld";

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/recipes/recipe-jsonld.test.ts -t "findRecipeNode|firstImageUrl|decodeEntities"`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement (append)**

```ts
function typeIsRecipe(type: unknown): boolean {
  const one = (t: unknown) => typeof t === "string" && (t === "Recipe" || t.endsWith("/Recipe"));
  return Array.isArray(type) ? type.some(one) : one(type);
}

export function findRecipeNode(
  nodes: Record<string, unknown>[],
): Record<string, unknown> | null {
  return nodes.find((node) => typeIsRecipe(node["@type"])) ?? null;
}

export function firstImageUrl(image: unknown): string | null {
  if (typeof image === "string") return image;
  if (Array.isArray(image)) {
    for (const item of image) {
      const url = firstImageUrl(item);
      if (url) return url;
    }
    return null;
  }
  if (image && typeof image === "object") {
    const url = (image as Record<string, unknown>).url;
    return typeof url === "string" ? url : null;
  }
  return null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  frac12: "½", frac13: "⅓", frac14: "¼", frac34: "¾", frac23: "⅔",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/recipes/recipe-jsonld.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/recipes/recipe-jsonld.ts lib/recipes/recipe-jsonld.test.ts
git commit -m "feat(recipes): recipe-node selection, image + entity helpers (#12a)"
```

---

### Task 4: `extractRecipeJsonLd` + saved-HTML fixtures

**Files:**
- Modify: `lib/recipes/recipe-jsonld.ts`
- Create: `lib/recipes/fixtures/single-recipe.html`, `graph.html`, `array-types.html`, `no-recipe.html`, `malformed.html`
- Test: `lib/recipes/recipe-jsonld.test.ts`

**Interfaces:**
- Consumes: all helpers from Tasks 1–3.
- Produces: `extractRecipeJsonLd(html: string): ExtractedRecipe | null` — the public entry point 12c calls.

- [ ] **Step 1: Create the fixtures**

`lib/recipes/fixtures/single-recipe.html`:
```html
<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Recipe","name":"Carnitas Tacos",
"image":"https://example.com/tacos.jpg","prepTime":"PT20M","cookTime":"PT1H30M",
"totalTime":"PT1H50M","recipeIngredient":["2 lb pork shoulder","1 tbsp ground cumin","3 corn tortillas"]}
</script></head><body>Recipe body</body></html>
```

`lib/recipes/fixtures/graph.html` (covers `@graph`, `@type` array, image `{url}`):
```html
<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
{"@type":"WebSite","name":"A Cooking Site"},
{"@type":["Recipe","Thing"],"name":"Graph Soup","image":{"url":"https://example.com/soup.jpg"},
"totalTime":"PT45M","recipeIngredient":["1 onion, diced","2 cups vegetable broth"]}]}
</script></head><body></body></html>
```

`lib/recipes/fixtures/array-types.html` (covers top-level array, legacy `ingredients`, image array):
```html
<!doctype html><html><head>
<script type="application/ld+json">
[{"@type":"Organization","name":"Org"},
{"@type":"Recipe","name":"Array Stew","image":["https://example.com/stew1.jpg","https://example.com/stew2.jpg"],
"ingredients":["3 carrots","1 lb beef chuck"]}]
</script></head><body></body></html>
```

`lib/recipes/fixtures/no-recipe.html`:
```html
<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Article","headline":"Not a recipe at all"}
</script></head><body></body></html>
```

`lib/recipes/fixtures/malformed.html` (first block invalid JSON; second is the Recipe with entities):
```html
<!doctype html><html><head>
<script type="application/ld+json">{ this is : not valid json }</script>
<script type="application/ld+json">
{"@type":"Recipe","name":"Recovered &amp; Tasty","recipeIngredient":["1 cup rice &amp; beans","&frac12; tsp salt"]}
</script></head><body></body></html>
```

- [ ] **Step 2: Write the failing test** (append)

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { extractRecipeJsonLd } from "./recipe-jsonld";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name), "utf8");

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
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run lib/recipes/recipe-jsonld.test.ts -t extractRecipeJsonLd`
Expected: FAIL — `extractRecipeJsonLd` not exported.

- [ ] **Step 4: Implement (append the public function)**

```ts
function ingredientLinesOf(node: Record<string, unknown>): string[] {
  const raw = node.recipeIngredient ?? node.ingredients;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((line): line is string => typeof line === "string")
    .map((line) => decodeEntities(line).trim())
    .filter((line) => line.length > 0);
}

export function extractRecipeJsonLd(html: string): ExtractedRecipe | null {
  const node = findRecipeNode(collectJsonLdNodes(html));
  if (!node) return null;
  const name = node.name;
  return {
    title: typeof name === "string" ? decodeEntities(name).trim() : null,
    imageUrl: firstImageUrl(node.image),
    ingredientLines: ingredientLinesOf(node),
    prepMinutes: isoDurationToMinutes(node.prepTime),
    cookMinutes: isoDurationToMinutes(node.cookTime),
    totalMinutes: isoDurationToMinutes(node.totalTime),
  };
}
```

- [ ] **Step 5: Run the full file + typecheck + lint**

Run: `npx vitest run lib/recipes/recipe-jsonld.test.ts`
Expected: PASS (all suites).
Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/recipes/recipe-jsonld.ts lib/recipes/recipe-jsonld.test.ts lib/recipes/fixtures
git commit -m "feat(recipes): extractRecipeJsonLd + saved-HTML fixtures (#12a)"
```

---

## Self-Review

**1. Spec coverage (12a):** ✅ HTML-string input (pure) → Task-wide; return type `ExtractedRecipe` → Task 1; scan all script blocks + object/array/@graph → Task 2; @type string/array (+ `/Recipe`) → Task 3; recipeIngredient + legacy `ingredients` → Task 4; ISO-8601 → minutes → Task 1; image string/{url}/array → Task 3; entity decode → Task 3; no-Recipe → null, malformed-skip → Tasks 2+4; first-Recipe-wins → Task 3 test. Skipped (microdata/RDFa, multi-recipe, network) — correctly absent.

**2. Placeholder scan:** none — every step has complete code.

**3. Type consistency:** `collectJsonLdNodes` → `Record<string,unknown>[]` feeds `findRecipeNode` (same type) feeds `extractRecipeJsonLd`. `isoDurationToMinutes(unknown)` accepts the `node.prepTime` (unknown) passed in Task 4. `firstImageUrl(unknown)`/`decodeEntities(string)` signatures match their call sites.
