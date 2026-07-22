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
