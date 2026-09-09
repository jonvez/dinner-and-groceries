import { describe, it, expect } from "vitest";
import { normalizeName, parseQuantity, matchUnit, parseIngredient } from "./ingredient";

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

describe("QA edge cases (#11)", () => {
  it("treats a zero quantity as a real quantity, not as absent (guards against `if (!quantity)` bugs)", () => {
    // `0` is falsy in JS; the implementation must check `=== null`, not truthiness.
    expect(parseIngredient("0 cups flour")).toEqual({
      quantity: 0, unit: "cup", name: "flour", rawText: "0 cups flour",
    });
  });

  it("does not crash on an empty string and preserves rawText", () => {
    expect(parseIngredient("")).toEqual({ quantity: null, unit: null, name: "", rawText: "" });
  });

  it("does not crash on a whitespace-only string; rawText keeps the original whitespace", () => {
    expect(parseIngredient("   ")).toEqual({ quantity: null, unit: null, name: "", rawText: "   " });
  });

  it("matches units case-insensitively through the full pipeline, not just via matchUnit", () => {
    expect(parseIngredient("2 CUPS flour")).toEqual({
      quantity: 2, unit: "cup", name: "flour", rawText: "2 CUPS flour",
    });
    expect(parseIngredient("8 FL OZ milk")).toEqual({
      quantity: 8, unit: "fl oz", name: "milk", rawText: "8 FL OZ milk",
    });
  });

  it("does not treat a leading minus sign as a quantity (falls back to name-only, no data loss)", () => {
    expect(parseIngredient("-2 cups flour")).toEqual({
      quantity: null, unit: null, name: "-2 cups flour", rawText: "-2 cups flour",
    });
  });

  it("assigns a unit even when nothing follows it (empty name), rather than erroring", () => {
    expect(parseIngredient("2 cups")).toEqual({
      quantity: 2, unit: "cup", name: "", rawText: "2 cups",
    });
  });

  it("deliberately does NOT match ambiguous single-letter abbreviations (c / t / T) as units", () => {
    // Per design doc: 'c', 'T', 't' are omitted from the unit table to avoid
    // false matches (e.g. "T" could be tablespoon or a name/initial). Locks the
    // intentional omission against an incautious future addition.
    expect(matchUnit("c")).toBeNull();
    expect(matchUnit("t")).toBeNull();
    expect(matchUnit("T")).toBeNull();
    expect(parseIngredient("2 c flour")).toEqual({
      quantity: 2, unit: null, name: "c flour", rawText: "2 c flour",
    });
  });

  it("normalizeName does not crash on empty or whitespace-only input", () => {
    expect(normalizeName("")).toBe("");
    expect(normalizeName("   ")).toBe("");
  });

  it("integration: count-item lines with different quantities dedupe to the same normalizeName key (#14)", () => {
    const a = parseIngredient("2 eggs");
    const b = parseIngredient("3 eggs");
    expect(a).toEqual({ quantity: 2, unit: null, name: "eggs", rawText: "2 eggs" });
    expect(b).toEqual({ quantity: 3, unit: null, name: "eggs", rawText: "3 eggs" });
    expect(normalizeName(a.name)).toBe(normalizeName(b.name));
    expect(normalizeName(a.name)).toBe("egg");
  });
});

/**
 * Leading list markers (#170). Pasting an ingredient list out of a recipe site
 * or a note carries the site's bullet with it; anchoring the quantity patterns
 * at the literal start of the string made every one of those lines fall through
 * to "no quantity, whole line is the name" — which also silently defeats the
 * roll-up, because `name` is the dedupe key (ADR 0003).
 */
describe("leading list markers (#170)", () => {
  const MARKERS = [
    ["hyphen", "- "],
    ["en dash", "– "],
    ["em dash", "— "],
    ["asterisk", "* "],
    ["bullet", "• "],
    ["middle dot", "· "],
    ["hollow square (recipe-site checkbox)", "▢ "],
    ["small square", "▪ "],
    ["standalone o (Word sub-bullet)", "o "],
    ["empty checkbox with a space", "[ ] "],
    ["empty checkbox", "[] "],
    ["numbered list with a period", "1. "],
    ["numbered list with a paren", "1) "],
    ["leading whitespace then a hyphen", "  - "],
    ["bullet with no space after it", "•"],
    ["checkbox after a bullet", "- [ ] "],
  ] as const;

  for (const [label, marker] of MARKERS) {
    it(`strips a leading ${label} and parses the line as if it were not there`, () => {
      const raw = `${marker}2 cups all-purpose flour`;
      expect(parseIngredient(raw)).toEqual({
        quantity: 2,
        unit: "cup",
        name: "all-purpose flour",
        rawText: raw,
      });
    });
  }

  it("reproduces every row of the issue's evidence table, fixed", () => {
    expect(parseIngredient("2 lb pork shoulder")).toMatchObject({
      quantity: 2, unit: "lb", name: "pork shoulder",
    });
    expect(parseIngredient("- 2 cups all-purpose flour")).toMatchObject({
      quantity: 2, unit: "cup", name: "all-purpose flour",
    });
    expect(parseIngredient("• 1 tbsp olive oil")).toMatchObject({
      quantity: 1, unit: "tbsp", name: "olive oil",
    });
    expect(parseIngredient("* 3 cloves garlic, minced")).toMatchObject({
      quantity: 3, unit: "clove", name: "garlic, minced",
    });
    expect(parseIngredient("▢ 1 tbsp olive oil")).toMatchObject({
      quantity: 1, unit: "tbsp", name: "olive oil",
    });
    expect(parseIngredient("  - 1 lb ground beef")).toMatchObject({
      quantity: 1, unit: "lb", name: "ground beef",
    });
    expect(parseIngredient("1. 2 cups flour")).toMatchObject({
      quantity: 2, unit: "cup", name: "flour",
    });
    expect(parseIngredient("2lb pork shoulder")).toMatchObject({
      quantity: 2, unit: "lb", name: "pork shoulder",
    });
    expect(parseIngredient("1 (14.5 oz) can diced tomatoes")).toMatchObject({
      quantity: 1, unit: "can", name: "diced tomatoes",
    });
  });

  it("never re-reads a stripped list number as the quantity", () => {
    expect(parseIngredient("1. 2 cups flour")).toEqual({
      quantity: 2, unit: "cup", name: "flour", rawText: "1. 2 cups flour",
    });
    expect(parseIngredient("3) 1 tsp salt")).toEqual({
      quantity: 1, unit: "tsp", name: "salt", rawText: "3) 1 tsp salt",
    });
  });

  it("does not mistake a decimal for a list number", () => {
    expect(parseIngredient("1.5 cups flour")).toEqual({
      quantity: 1.5, unit: "cup", name: "flour", rawText: "1.5 cups flour",
    });
  });

  it("strips the marker from an unquantified line too, so it cannot poison the dedupe key", () => {
    expect(parseIngredient("- Kosher salt")).toEqual({
      quantity: null, unit: null, name: "Kosher salt", rawText: "- Kosher salt",
    });
    expect(parseIngredient("▢ Olive oil, for frying")).toEqual({
      quantity: null, unit: null, name: "Olive oil, for frying",
      rawText: "▢ Olive oil, for frying",
    });
  });

  it("leaves a genuinely unquantified line with no marker exactly as it was", () => {
    expect(parseIngredient("Kosher salt")).toEqual({
      quantity: null, unit: null, name: "Kosher salt", rawText: "Kosher salt",
    });
    expect(parseIngredient("Olive oil, for frying")).toEqual({
      quantity: null, unit: null, name: "Olive oil, for frying",
      rawText: "Olive oil, for frying",
    });
  });

  it("preserves rawText verbatim, marker and all", () => {
    expect(parseIngredient("  - 1 lb ground beef").rawText).toBe("  - 1 lb ground beef");
    expect(parseIngredient("▢ 1 tbsp olive oil").rawText).toBe("▢ 1 tbsp olive oil");
  });

  it("strips the marker inside parseQuantity, so the remainder is unit-matchable", () => {
    expect(parseQuantity("- 2 cups flour")).toEqual({ quantity: 2, rest: "cups flour" });
    expect(parseQuantity("• ½ cup sugar")).toEqual({ quantity: 0.5, rest: "cup sugar" });
    expect(parseQuantity("- salt to taste")).toEqual({ quantity: null, rest: "salt to taste" });
  });

  it("still refuses a minus sign glued to a number (not a bullet — no data loss)", () => {
    expect(parseIngredient("-2 cups flour")).toEqual({
      quantity: null, unit: null, name: "-2 cups flour", rawText: "-2 cups flour",
    });
  });

  it("does not eat a hyphenated ingredient name", () => {
    expect(parseIngredient("all-purpose flour")).toEqual({
      quantity: null, unit: null, name: "all-purpose flour", rawText: "all-purpose flour",
    });
  });

  it("makes a bulleted line dedupe with the same ingredient typed plainly (#14)", () => {
    const bulleted = parseIngredient("- 2 cups all-purpose flour");
    const plain = parseIngredient("1 cup all-purpose flour");
    expect(normalizeName(bulleted.name)).toBe(normalizeName(plain.name));
    expect(bulleted.unit).toBe(plain.unit);
  });
});

describe("digit glued to its unit (#170)", () => {
  it("splits a quantity glued to a known unit", () => {
    expect(parseIngredient("2lb pork shoulder")).toEqual({
      quantity: 2, unit: "lb", name: "pork shoulder", rawText: "2lb pork shoulder",
    });
    expect(parseIngredient("500g flour")).toEqual({
      quantity: 500, unit: "g", name: "flour", rawText: "500g flour",
    });
    expect(parseIngredient("1.5kg beef chuck")).toEqual({
      quantity: 1.5, unit: "kg", name: "beef chuck", rawText: "1.5kg beef chuck",
    });
    expect(parseIngredient("- 2lb pork shoulder")).toMatchObject({
      quantity: 2, unit: "lb", name: "pork shoulder",
    });
  });

  it("only splits when the glued letters are a KNOWN unit, so a product code stays intact", () => {
    expect(parseIngredient("2x4 lumber")).toEqual({
      quantity: null, unit: null, name: "2x4 lumber", rawText: "2x4 lumber",
    });
    expect(parseIngredient("6oz can")).toMatchObject({ quantity: 6, unit: "oz", name: "can" });
  });
});

describe("parenthetical package size (#170)", () => {
  it("drops a numeric package size so the real unit and name survive", () => {
    expect(parseIngredient("1 (14.5 oz) can diced tomatoes")).toEqual({
      quantity: 1, unit: "can", name: "diced tomatoes",
      rawText: "1 (14.5 oz) can diced tomatoes",
    });
    expect(parseIngredient("2 (15 oz) cans black beans")).toMatchObject({
      quantity: 2, unit: "can", name: "black beans",
    });
    expect(parseIngredient("1 (14.5-ounce) can crushed tomatoes")).toMatchObject({
      quantity: 1, unit: "can", name: "crushed tomatoes",
    });
  });

  it("leaves no digit or unit token in the name", () => {
    const { name } = parseIngredient("- 1 (14.5 oz) can diced tomatoes");
    expect(name).toBe("diced tomatoes");
    expect(name).not.toMatch(/\d/);
  });

  it("keeps a NON-numeric parenthetical, which is a descriptor and out of scope", () => {
    // Descriptor words in the name are explicitly out of scope for #170.
    expect(parseIngredient("1 (large) onion")).toMatchObject({
      quantity: 1, unit: null, name: "(large) onion",
    });
  });

  it("leaves an unclosed parenthesis alone rather than swallowing the line", () => {
    expect(parseIngredient("1 (14.5 oz can diced tomatoes")).toMatchObject({
      quantity: 1, unit: null, name: "(14.5 oz can diced tomatoes",
    });
  });
});
