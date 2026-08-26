import { describe, expect, it } from "vitest";

import type { CatalogRow } from "./list-core";
import { MAX_SUGGESTIONS, suggestStaples } from "./suggest-core";

/**
 * Staple autocomplete (#148). The rules of record, each traceable to a source
 * rather than to taste:
 *   - suggestions from the FIRST character, because the catalog is local and
 *     the 3-char rule exists to avoid server work (NN/g mobile-input checklist);
 *   - at most 5, because that is where GOV.UK caps it "to reduce cognitive load
 *     and prevent unnecessary scrolling" (Baymard: 4–8 on mobile);
 *   - matches land ANYWHERE, so "oil" finds "olive oil", but a name that starts
 *     with the query wins — that is almost always the one you meant;
 *   - the returned split highlights the QUERY, per NN/g's conditional rule for
 *     match-anywhere suggestions, and must never corrupt the displayed name.
 */

const staple = (o: Partial<CatalogRow> & { id: string; name: string }): CatalogRow => ({
  defaultUnit: null,
  addedCount: 0,
  ...o,
});

const CATALOG: CatalogRow[] = [
  staple({ id: "1", name: "Milk" }),
  staple({ id: "2", name: "olive oil" }),
  staple({ id: "3", name: "Mozzarella" }),
  staple({ id: "4", name: "peanut oil" }),
  staple({ id: "5", name: "Broiler" }),
  staple({ id: "6", name: "molasses" }),
  staple({ id: "7", name: "Monkfruit" }),
  staple({ id: "8", name: "mop heads" }),
  staple({ id: "9", name: "mint" }),
];

const names = (q: string, catalog = CATALOG) =>
  suggestStaples(q, catalog).map((s) => s.name);

describe("suggestStaples", () => {
  it("suggests from a single character — there is no 3-character wait", () => {
    expect(names("m").length).toBeGreaterThan(0);
  });

  it("returns nothing for an empty or whitespace-only query", () => {
    // An empty field is not a search. Showing the first five alphabetically
    // would be the 492-chip problem again, just smaller.
    expect(names("")).toEqual([]);
    expect(names("   ")).toEqual([]);
  });

  it("caps at five suggestions", () => {
    // Nine catalog rows, seven of which contain "o".
    expect(names("o").length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
    expect(names("m")).toHaveLength(MAX_SUGGESTIONS);
  });

  it("matches case-insensitively", () => {
    expect(names("MILK")).toEqual(["Milk"]);
    expect(names("mozz")).toEqual(["Mozzarella"]);
  });

  it("finds a match in the middle of a name", () => {
    expect(names("oil")).toContain("olive oil");
    expect(names("oil")).toContain("peanut oil");
  });

  it("ranks a name that STARTS with the query above one that merely contains it", () => {
    // "olive oil" starts with "ol"; "molasses" only contains it, mid-word.
    const result = names("ol");
    expect(result.indexOf("olive oil")).toBeLessThan(result.indexOf("molasses"));
  });

  it("ranks a word-start match above a mid-word one", () => {
    // "oil" begins a word in "peanut oil"; in "Broiler" it is buried.
    const result = names("oil");
    expect(result.indexOf("peanut oil")).toBeLessThan(result.indexOf("Broiler"));
  });

  it("breaks ties by how often the staple has actually been added", () => {
    const catalog = [
      staple({ id: "a", name: "milk chocolate", addedCount: 0 }),
      staple({ id: "b", name: "milk", addedCount: 7 }),
    ];
    // Both are prefix matches, so the real usage signal decides.
    expect(names("milk", catalog)).toEqual(["milk", "milk chocolate"]);
  });

  it("falls back to alphabetical when nothing has been added yet", () => {
    // Today's state: every imported staple has the same count, so the order
    // must still be stable and predictable rather than arbitrary.
    const catalog = [
      staple({ id: "a", name: "mustard" }),
      staple({ id: "b", name: "mango" }),
      staple({ id: "c", name: "mint" }),
    ];
    expect(names("m", catalog)).toEqual(["mango", "mint", "mustard"]);
  });

  it("ignores surrounding whitespace and collapses runs inside the query", () => {
    expect(names("  olive   oil  ")).toEqual(["olive oil"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(names("zzz")).toEqual([]);
  });

  it("splits the name so the typed text can be bolded, in the STAPLE's casing", () => {
    // "molasses" is lowercase, so the highlighted run is "mo" — the staple's
    // own casing, never the casing the user happened to type.
    const [molasses] = suggestStaples("mo", CATALOG);
    expect(molasses.segments).toEqual({ before: "", match: "mo", after: "lasses" });

    // The same query against a capitalised staple keeps ITS casing.
    const monkfruit = suggestStaples("MO", CATALOG).find((s) => s.name === "Monkfruit");
    expect(monkfruit?.segments).toEqual({ before: "", match: "Mo", after: "nkfruit" });
  });

  it("splits correctly for a match in the middle", () => {
    const [suggestion] = suggestStaples("live", CATALOG);
    expect(suggestion.segments).toEqual({ before: "o", match: "live", after: " oil" });
  });

  it("never corrupts the displayed name, whatever the split", () => {
    for (const query of ["m", "oil", "o", "li", "t", "MILK"]) {
      for (const s of suggestStaples(query, CATALOG)) {
        const { before, match, after } = s.segments;
        expect(before + match + after).toBe(s.name.trim());
      }
    }
  });

  it("carries the default unit through, so picking a staple can prefill it", () => {
    const catalog = [staple({ id: "u", name: "Milk", defaultUnit: "gal" })];
    expect(suggestStaples("mi", catalog)[0]).toMatchObject({
      id: "u",
      name: "Milk",
      defaultUnit: "gal",
    });
  });
});
