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
