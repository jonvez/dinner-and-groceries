# Ingredient Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A framework-free `lib/` parser that turns a raw ingredient string into structured, mergeable `{quantity, unit, name, rawText}`, plus a `normalizeName` dedupe key.

**Architecture:** One module, `lib/recipes/ingredient.ts`, of pure functions with no I/O and no Supabase dependency. `parseIngredient` composes three exported building blocks — `parseQuantity` (strip a leading amount), `matchUnit` (canonical unit lookup over a closed synonym table), and the name remainder — and `normalizeName` produces the dedupe key. Tests are colocated in `ingredient.test.ts` and are written strict-test-first.

**Tech Stack:** TypeScript, Vitest. Framework-free; **no new npm dependency** (a third-party parser would trigger a security review and own the app's riskiest logic).

**Design spec:** `docs/superpowers/specs/2026-07-22-ingredient-parser-design.md` (read it first).

## Global Constraints

- **Pure `lib/` only:** no I/O, no Supabase import, no framework. (`ParsedIngredient` is plain data.) — Issue #11 AC.
- **`rawText` preserved on every parse path** — verbatim input, never lost. — ADR 0003 / AC.
- **No unit conversion** — different units never merge; they list separately. — ADR 0003.
- **No external food database / network** — the closed unit table is the only "dictionary." — design spec.
- **Strict test-first:** every behavior gets a failing test, watched fail, then minimal implementation. — TEAM.md DoD.
- **`lib/` style (match `lib/social/nudge.ts`):** named exports, `readonly` inputs where applicable, no mutation of inputs, tunable constants/tables in one place, doc comments explaining the "why".
- **Field model is exactly 4 fields** (`quantity, unit, name, rawText`); `name` is stored **display-form** (original case), *not* normalized — normalization happens only via `normalizeName`.
- **camelCase in the lib** (`rawText`), mapped to the `raw_text` column at the DB boundary by later tickets — not here.

---

### Task 1: Module scaffold + `ParsedIngredient` type + `normalizeName`

**Files:**
- Create: `lib/recipes/ingredient.ts`
- Test: `lib/recipes/ingredient.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ParsedIngredient = { quantity: number | null; unit: string | null; name: string; rawText: string }`
  - `function normalizeName(name: string): string` — trim / lowercase / collapse-whitespace / singularize the last word. The dedupe key consumed by #14.

- [ ] **Step 1: Write the failing tests**

Create `lib/recipes/ingredient.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeName } from "./ingredient";

describe("normalizeName", () => {
  it("trims, lowercases, and collapses whitespace", () => {
    expect(normalizeName("  All-Purpose   Flour ")).toBe("all-purpose flour");
  });

  it("singularizes a trailing plural (regular -s)", () => {
    expect(normalizeName("eggs")).toBe("egg");
    expect(normalizeName("Cherry Tomatoes")).toBe("cherry tomato"); // -oes
  });

  it("singularizes -ies -> -y and -es clusters", () => {
    expect(normalizeName("berries")).toBe("berry");
    expect(normalizeName("dishes")).toBe("dish");
    expect(normalizeName("boxes")).toBe("box");
    expect(normalizeName("glasses")).toBe("glass"); // -sses -> strip "es"
    expect(normalizeName("roses")).toBe("rose");     // -ses (single s) -> strip only "s"
  });

  it("uses the irregular map where strip-s would be wrong", () => {
    expect(normalizeName("leaves")).toBe("leaf");
    expect(normalizeName("loaves")).toBe("loaf");
  });

  it("does not over-strip 'ss' words or already-singular words", () => {
    expect(normalizeName("glass")).toBe("glass");
    expect(normalizeName("flour")).toBe("flour");
  });

  it("only singularizes the last word", () => {
    expect(normalizeName("olives")).toBe("olive");
    expect(normalizeName("green olives")).toBe("green olive");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/recipes/ingredient.test.ts`
Expected: FAIL — `normalizeName` not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `lib/recipes/ingredient.ts`:

```ts
/**
 * Framework-free ingredient parser (issue #11, Slice 1c). Turns a raw ingredient
 * line — from JSON-LD extraction (#12) or hand entry — into structured, mergeable
 * data. Pure: no I/O, no Supabase. `rawText` is preserved on every path so nothing
 * is lost and every line stays user-correctable downstream (#12).
 *
 * Dedupe (#14) is a normalized-STRING match (ADR 0003), never semantic identity —
 * which is why a small closed unit table, not an external food database, is all we
 * need. See docs/superpowers/specs/2026-07-22-ingredient-parser-design.md.
 */

export type ParsedIngredient = {
  /** Numeric amount, or null when there is no leading quantity ("salt to taste"). */
  quantity: number | null;
  /** Canonical measurement unit if recognized, else null (count/unmeasured items). */
  unit: string | null;
  /** Cleaned display form, original case ("all-purpose flour"). NOT normalized. */
  name: string;
  /** Verbatim input — preserved on every path, never lost. */
  rawText: string;
};

/**
 * Irregular plurals where naive strip-`s`/`ves` would be wrong. Grows as real data
 * demands — kept in one place.
 */
const IRREGULAR_SINGULARS: Record<string, string> = {
  leaves: "leaf",
  loaves: "loaf",
};

/** Singularize a single lowercased word (best-effort, deterministic, no NLP dep). */
function singularizeWord(word: string): string {
  if (word in IRREGULAR_SINGULARS) return IRREGULAR_SINGULARS[word];
  if (word.endsWith("ies") && word.length > 3) return word.slice(0, -3) + "y";
  if (word.endsWith("oes")) return word.slice(0, -2); // tomatoes -> tomato
  if (/(ss|ch|sh|x|z)es$/.test(word)) return word.slice(0, -2); // glasses -> glass, dishes -> dish, boxes -> box
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1); // eggs -> egg, roses -> rose
  return word;
}

/**
 * The dedupe key for #14: trim / lowercase / collapse-whitespace / singularize the
 * last word. Applied at dedupe time so stored `name` stays display-form.
 */
export function normalizeName(name: string): string {
  const cleaned = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (cleaned === "") return "";
  const words = cleaned.split(" ");
  words[words.length - 1] = singularizeWord(words[words.length - 1]);
  return words.join(" ");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/recipes/ingredient.test.ts`
Expected: PASS (all `normalizeName` cases).

- [ ] **Step 5: Commit**

```bash
git add lib/recipes/ingredient.ts lib/recipes/ingredient.test.ts
git commit -m "feat(recipes): ParsedIngredient type + normalizeName dedupe key (#11)"
```

---

### Task 2: `parseQuantity` — leading amount (fractions, mixed, ranges)

**Files:**
- Modify: `lib/recipes/ingredient.ts`
- Test: `lib/recipes/ingredient.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `function parseQuantity(text: string): { quantity: number | null; rest: string }` — strips a leading quantity token and returns the numeric value (or null) plus the remaining string (left-trimmed). Ranges resolve to the **high end** (never under-buy).

- [ ] **Step 1: Write the failing tests**

Append to `lib/recipes/ingredient.test.ts`:

```ts
import { parseQuantity } from "./ingredient";

describe("parseQuantity", () => {
  it("parses integers and decimals", () => {
    expect(parseQuantity("2 cups flour")).toEqual({ quantity: 2, rest: "cups flour" });
    expect(parseQuantity("0.5 cup milk")).toEqual({ quantity: 0.5, rest: "cup milk" });
  });

  it("parses ascii fractions", () => {
    expect(parseQuantity("1/2 cup sugar")).toEqual({ quantity: 0.5, rest: "cup sugar" });
  });

  it("parses vulgar fractions", () => {
    expect(parseQuantity("½ cup sugar")).toEqual({ quantity: 0.5, rest: "cup sugar" });
  });

  it("parses mixed numbers (attached and spaced)", () => {
    expect(parseQuantity("1½ cups flour")).toEqual({ quantity: 1.5, rest: "cups flour" });
    expect(parseQuantity("1 1/2 cups flour")).toEqual({ quantity: 1.5, rest: "cups flour" });
  });

  it("resolves ranges to the high end and keeps the remainder", () => {
    expect(parseQuantity("2-3 cups rice")).toEqual({ quantity: 3, rest: "cups rice" });
    expect(parseQuantity("2 to 3 cups rice")).toEqual({ quantity: 3, rest: "cups rice" });
  });

  it("returns null quantity when there is no leading amount", () => {
    expect(parseQuantity("salt to taste")).toEqual({ quantity: null, rest: "salt to taste" });
    expect(parseQuantity("juice of 3 limes")).toEqual({ quantity: null, rest: "juice of 3 limes" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/recipes/ingredient.test.ts -t parseQuantity`
Expected: FAIL — `parseQuantity` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/recipes/ingredient.ts` (above `normalizeName` is fine; keep related constants together):

```ts
/** Unicode vulgar fractions → numeric value. */
const VULGAR_FRACTIONS: Record<string, number> = {
  "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4,
  "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5, "⅘": 4 / 5,
  "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8,
};
const VULGAR_CLASS = "½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";

/**
 * Strip a leading quantity from `text`. Returns the numeric value (or null when the
 * line has no leading amount) and the left-trimmed remainder. A RANGE ("2-3", "2 to
 * 3") resolves to the HIGH end so a grocery list never under-buys; `rawText`
 * upstream still preserves the original range verbatim.
 */
export function parseQuantity(text: string): { quantity: number | null; rest: string } {
  const s = text.trimStart();

  // Range: high end wins.
  const range = s.match(
    new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:-|–|to)\\s*(\\d+(?:\\.\\d+)?)\\b(.*)$`),
  );
  if (range) {
    return { quantity: Math.max(parseFloat(range[1]), parseFloat(range[2])), rest: range[3].trimStart() };
  }

  // Mixed: integer + (ascii or vulgar) fraction, attached or spaced.
  const mixed = s.match(new RegExp(`^(\\d+)\\s*(?:(\\d+)\\/(\\d+)|([${VULGAR_CLASS}]))(.*)$`));
  if (mixed) {
    const whole = parseInt(mixed[1], 10);
    const frac = mixed[2] ? parseInt(mixed[2], 10) / parseInt(mixed[3], 10) : VULGAR_FRACTIONS[mixed[4]];
    return { quantity: whole + frac, rest: mixed[5].trimStart() };
  }

  // Standalone vulgar fraction.
  const vulgar = s.match(new RegExp(`^([${VULGAR_CLASS}])(.*)$`));
  if (vulgar) return { quantity: VULGAR_FRACTIONS[vulgar[1]], rest: vulgar[2].trimStart() };

  // Standalone ascii fraction.
  const frac = s.match(/^(\d+)\/(\d+)\b(.*)$/);
  if (frac) return { quantity: parseInt(frac[1], 10) / parseInt(frac[2], 10), rest: frac[3].trimStart() };

  // Plain integer or decimal.
  const num = s.match(/^(\d+(?:\.\d+)?)\b(.*)$/);
  if (num) return { quantity: parseFloat(num[1]), rest: num[2].trimStart() };

  // No leading quantity.
  return { quantity: null, rest: text.trim() };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/recipes/ingredient.test.ts -t parseQuantity`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/recipes/ingredient.ts lib/recipes/ingredient.test.ts
git commit -m "feat(recipes): parseQuantity — fractions, mixed numbers, ranges (#11)"
```

---

### Task 3: Unit table + `matchUnit`

**Files:**
- Modify: `lib/recipes/ingredient.ts`
- Test: `lib/recipes/ingredient.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `function matchUnit(token: string): string | null` — case-insensitive, synonym-folded lookup returning the canonical unit, or null if the token is not a known measurement unit. Callers handle multi-word units (e.g. `"fl oz"`) by passing the joined two-word string.

- [ ] **Step 1: Write the failing tests**

Append to `lib/recipes/ingredient.test.ts`:

```ts
import { matchUnit } from "./ingredient";

describe("matchUnit", () => {
  it("folds synonyms and plurals to a canonical unit", () => {
    expect(matchUnit("cups")).toBe("cup");
    expect(matchUnit("Cup")).toBe("cup");
    expect(matchUnit("tablespoons")).toBe("tbsp");
    expect(matchUnit("tbsp")).toBe("tbsp");
    expect(matchUnit("grams")).toBe("g");
    expect(matchUnit("g")).toBe("g");
  });

  it("recognizes metric and two-word units", () => {
    expect(matchUnit("ml")).toBe("ml");
    expect(matchUnit("fl oz")).toBe("fl oz");
  });

  it("tolerates a trailing period", () => {
    expect(matchUnit("tbsp.")).toBe("tbsp");
  });

  it("returns null for non-units", () => {
    expect(matchUnit("eggs")).toBeNull();
    expect(matchUnit("flour")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/recipes/ingredient.test.ts -t matchUnit`
Expected: FAIL — `matchUnit` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/recipes/ingredient.ts`:

```ts
/**
 * Closed measurement-unit table: synonym/plural → canonical form. The ONLY
 * "dictionary" in the parser (ADR 0003 — dedupe is exact-normalized-unit match, no
 * conversion). Single-letter ambiguous abbreviations (`c`, `T`/`t`) are deliberately
 * omitted to avoid false matches; unambiguous metric single letters (`g`, `l`) are
 * kept. Extend here as real recipe lines demand.
 */
const UNIT_SYNONYMS: Record<string, string> = {
  teaspoon: "tsp", teaspoons: "tsp", tsp: "tsp", tsps: "tsp",
  tablespoon: "tbsp", tablespoons: "tbsp", tbsp: "tbsp", tbsps: "tbsp", tbs: "tbsp",
  cup: "cup", cups: "cup",
  pint: "pint", pints: "pint", pt: "pint",
  quart: "quart", quarts: "quart", qt: "quart",
  gallon: "gallon", gallons: "gallon", gal: "gallon",
  "fl oz": "fl oz", "fluid ounce": "fl oz", "fluid ounces": "fl oz", floz: "fl oz",
  ounce: "oz", ounces: "oz", oz: "oz",
  pound: "lb", pounds: "lb", lb: "lb", lbs: "lb",
  gram: "g", grams: "g", g: "g",
  kilogram: "kg", kilograms: "kg", kg: "kg",
  milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml", ml: "ml",
  liter: "l", liters: "l", litre: "l", litres: "l", l: "l",
  clove: "clove", cloves: "clove",
  can: "can", cans: "can",
  package: "package", packages: "package", pkg: "package", pkgs: "package",
  stick: "stick", sticks: "stick",
  pinch: "pinch", pinches: "pinch",
  dash: "dash", dashes: "dash",
  slice: "slice", slices: "slice",
};

/**
 * Canonical unit for `token`, or null if it is not a known measurement unit.
 * Case-insensitive; folds a single trailing period. Multi-word units (e.g. "fl oz")
 * are matched by passing the joined two-word string.
 */
export function matchUnit(token: string): string | null {
  const key = token.trim().toLowerCase().replace(/\.$/, "");
  return UNIT_SYNONYMS[key] ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/recipes/ingredient.test.ts -t matchUnit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/recipes/ingredient.ts lib/recipes/ingredient.test.ts
git commit -m "feat(recipes): closed unit table + matchUnit lookup (#11)"
```

---

### Task 4: `parseIngredient` — compose the full parse (satisfies the AC)

**Files:**
- Modify: `lib/recipes/ingredient.ts`
- Test: `lib/recipes/ingredient.test.ts`

**Interfaces:**
- Consumes: `parseQuantity` (Task 2), `matchUnit` (Task 3), `ParsedIngredient` (Task 1).
- Produces: `function parseIngredient(raw: string): ParsedIngredient` — the public entry point. Unit is assigned **only when a quantity is present**; two-word units are tried before one-word; `rawText` is the verbatim input on every path.

- [ ] **Step 1: Write the failing tests**

Append to `lib/recipes/ingredient.test.ts`:

```ts
import { parseIngredient } from "./ingredient";

describe("parseIngredient", () => {
  it("parses the canonical AC example", () => {
    expect(parseIngredient("1½ cups all-purpose flour")).toEqual({
      quantity: 1.5, unit: "cup", name: "all-purpose flour", rawText: "1½ cups all-purpose flour",
    });
  });

  it("treats a non-unit token as a count item (unit=null)", () => {
    expect(parseIngredient("2 eggs")).toEqual({
      quantity: 2, unit: null, name: "eggs", rawText: "2 eggs",
    });
  });

  it("parses metric without converting", () => {
    expect(parseIngredient("200 g flour")).toEqual({
      quantity: 200, unit: "g", name: "flour", rawText: "200 g flour",
    });
  });

  it("keeps null quantity/unit and full name for unquantified lines", () => {
    expect(parseIngredient("salt to taste")).toEqual({
      quantity: null, unit: null, name: "salt to taste", rawText: "salt to taste",
    });
  });

  it("does not assign a unit when there is no quantity", () => {
    expect(parseIngredient("pinch of salt")).toEqual({
      quantity: null, unit: null, name: "pinch of salt", rawText: "pinch of salt",
    });
  });

  it("resolves a range to the high end", () => {
    expect(parseIngredient("2-3 cups rice")).toEqual({
      quantity: 3, unit: "cup", name: "rice", rawText: "2-3 cups rice",
    });
  });

  it("matches a two-word unit before falling back to one word", () => {
    expect(parseIngredient("8 fl oz milk")).toEqual({
      quantity: 8, unit: "fl oz", name: "milk", rawText: "8 fl oz milk",
    });
  });

  it("collapses internal whitespace in the name but preserves rawText verbatim", () => {
    expect(parseIngredient("2 cups   chopped   onion")).toEqual({
      quantity: 2, unit: "cup", name: "chopped onion", rawText: "2 cups   chopped   onion",
    });
  });

  it("preserves rawText on the deferred 'of' form (documented limitation)", () => {
    // "juice of N X" is a known limitation: parses as name-only, no data lost.
    expect(parseIngredient("juice of 3 limes")).toEqual({
      quantity: null, unit: null, name: "juice of 3 limes", rawText: "juice of 3 limes",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/recipes/ingredient.test.ts -t parseIngredient`
Expected: FAIL — `parseIngredient` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/recipes/ingredient.ts`:

```ts
/**
 * Parse one raw ingredient line into structured, mergeable fields. Pure; no I/O.
 * Pipeline: preserve rawText → strip leading quantity → (only if a quantity was
 * found) match a unit (two-word before one-word) → remainder is the display name.
 * A measurement unit with no preceding quantity is meaningless, so unquantified
 * lines get unit=null and the whole remainder as the name.
 */
export function parseIngredient(raw: string): ParsedIngredient {
  const rawText = raw;
  const collapsed = raw.trim().replace(/\s+/g, " ");
  const { quantity, rest } = parseQuantity(collapsed);

  if (quantity === null) {
    return { quantity: null, unit: null, name: rest, rawText };
  }

  const tokens = rest.length ? rest.split(" ") : [];
  let unit: string | null = null;
  let nameTokens = tokens;

  if (tokens.length >= 2) {
    const two = matchUnit(`${tokens[0]} ${tokens[1]}`);
    if (two) {
      unit = two;
      nameTokens = tokens.slice(2);
    }
  }
  if (unit === null && tokens.length >= 1) {
    const one = matchUnit(tokens[0]);
    if (one) {
      unit = one;
      nameTokens = tokens.slice(1);
    }
  }

  return { quantity, unit, name: nameTokens.join(" "), rawText };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/recipes/ingredient.test.ts -t parseIngredient`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/recipes/ingredient.ts lib/recipes/ingredient.test.ts
git commit -m "feat(recipes): parseIngredient composes the full parse (#11)"
```

---

### Task 5: Full-suite verification gate

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the whole unit suite**

Run: `npm test`
Expected: PASS — the new `lib/recipes/ingredient.test.ts` suite passes alongside every existing suite (no regressions).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors. (If ESLint flags the `new RegExp` template strings or the Unicode class, address per existing repo conventions — do not disable rules wholesale.)

- [ ] **Step 4: Confirm the public surface**

Verify `lib/recipes/ingredient.ts` exports exactly: `ParsedIngredient`, `parseIngredient`, `normalizeName` (public API), plus `parseQuantity` and `matchUnit` (exported building blocks, tested directly — consistent with `lib/social/nudge.ts` exporting its sub-functions). No default export.

- [ ] **Step 5: Commit any lint fixups (if needed)**

```bash
git add lib/recipes/ingredient.ts lib/recipes/ingredient.test.ts
git commit -m "chore(recipes): lint/typecheck clean-up for ingredient parser (#11)"
```

---

## Notes for the PR (developer)

- PR title: `feat(recipes): ingredient parser + normalizeName (#11)`; body includes `Closes #11` (per evt-0003-era habit: PRs carry Closes/Refs so the board and issue state move together).
- Link the design spec (`docs/superpowers/specs/2026-07-22-ingredient-parser-design.md`) in the PR body.
- Required checks on `main`: "Lint, typecheck, unit tests", "Playwright smoke E2E", "RLS pgTAP (Supabase)" — all must be green. This change touches no routes/DB, so E2E and pgTAP should pass unaffected.
- QA verifies the parse table against the AC; PO accepts against #11's acceptance criteria.
