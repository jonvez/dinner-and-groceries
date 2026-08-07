import { describe, expect, it } from "vitest";

import { planRollup, type ExistingGroceryItem } from "./rollup";

/**
 * The roll-up planner is the riskiest logic in Slice 1d — it decides what the
 * family's grocery list becomes every time the menu changes. These tests pin the
 * rules of record (ADR 0003 + the 2026-08-07 kickoff):
 *   - dedupe key = normalized name + EXACT unit (no conversion); an empty/absent
 *     unit is its own key, and never merges with a real unit;
 *   - quantities sum only PRESENT values — a null contributes nothing and is
 *     never coerced to 1; all-null stays null (unquantified items are valid);
 *   - merge, never clobber: edited / checked / have-it / ad-hoc rows are never
 *     updated or deleted, AND they claim their dedupe key;
 *   - untouched-only removal: an untouched auto-row whose key is no longer
 *     produced disappears; nothing else is ever deleted;
 *   - "N added, M removed" counts inserts and untouched-auto deletions only —
 *     a quantity refresh on a surviving row is neither.
 */

const auto = (o: Partial<ExistingGroceryItem> & { id: string }): ExistingGroceryItem => ({
  name: "x",
  quantity: null,
  unit: null,
  ingredientId: "i",
  haveIt: false,
  checked: false,
  edited: false,
  ...o,
});

describe("planRollup", () => {
  it("sums same normalized-name + same unit into one row", () => {
    const p = planRollup(
      [
        { ingredientId: "i1", name: "Flour", quantity: 2, unit: "cup" },
        { ingredientId: "i2", name: "flour", quantity: 1, unit: "cup" },
      ],
      [],
    );
    expect(p.toInsert).toEqual([{ name: "Flour", quantity: 3, unit: "cup", ingredientId: "i1" }]);
    expect(p.added).toBe(1);
  });

  it("merges case / plural / whitespace variants of the same name", () => {
    const p = planRollup(
      [
        { ingredientId: "i1", name: "Chicken Breasts", quantity: 2, unit: null },
        { ingredientId: "i2", name: "  chicken   breast ", quantity: 1, unit: null },
      ],
      [],
    );
    expect(p.toInsert).toEqual([
      { name: "Chicken Breasts", quantity: 3, unit: null, ingredientId: "i1" },
    ]);
  });

  it("lists un-mergeable units separately", () => {
    const p = planRollup(
      [
        { ingredientId: "i1", name: "flour", quantity: 2, unit: "cup" },
        { ingredientId: "i2", name: "flour", quantity: 100, unit: "g" },
      ],
      [],
    );
    expect(p.toInsert).toHaveLength(2);
  });

  it("keeps quantity null when every contributor is null (optional qty)", () => {
    const p = planRollup(
      [
        { ingredientId: "i1", name: "eggs", quantity: null, unit: null },
        { ingredientId: "i2", name: "Eggs", quantity: null, unit: null },
      ],
      [],
    );
    expect(p.toInsert).toEqual([{ name: "eggs", quantity: null, unit: null, ingredientId: "i1" }]);
  });

  it("sums only present quantities; a null contributes nothing (never 1)", () => {
    const p = planRollup(
      [
        { ingredientId: "i1", name: "milk", quantity: 1, unit: "cup" },
        { ingredientId: "i2", name: "milk", quantity: null, unit: "cup" },
      ],
      [],
    );
    expect(p.toInsert[0].quantity).toBe(1);
  });

  it("merges an unmerged null-unit with a real unit never (distinct keys)", () => {
    const p = planRollup(
      [
        { ingredientId: "i1", name: "salt", quantity: null, unit: null },
        { ingredientId: "i2", name: "salt", quantity: 1, unit: "tsp" },
      ],
      [],
    );
    expect(p.toInsert).toHaveLength(2);
  });

  it("treats an empty-string unit and an absent unit as the SAME key", () => {
    const p = planRollup(
      [
        { ingredientId: "i1", name: "eggs", quantity: 2, unit: "" },
        { ingredientId: "i2", name: "eggs", quantity: 6, unit: null },
      ],
      [],
    );
    expect(p.toInsert).toHaveLength(1);
    expect(p.toInsert[0].quantity).toBe(8);
  });

  it("never collides a name-with-spaces against a multi-word unit", () => {
    // "chicken" + "fl oz" and "chicken fl" + "oz" must stay two rows.
    const p = planRollup(
      [
        { ingredientId: "i1", name: "chicken", quantity: 1, unit: "fl oz" },
        { ingredientId: "i2", name: "chicken fl", quantity: 1, unit: "oz" },
      ],
      [],
    );
    expect(p.toInsert).toHaveLength(2);
  });

  it("rolls a dish slotted twice up twice (caller passes its lines per slotting)", () => {
    const line = { ingredientId: "i1", name: "onion", quantity: 1, unit: null };
    const p = planRollup([line, line], []);
    expect(p.toInsert).toEqual([{ name: "onion", quantity: 2, unit: null, ingredientId: "i1" }]);
  });

  it("updates an untouched auto-row's quantity in place (not added/removed)", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "flour", quantity: 3, unit: "cup" }],
      [auto({ id: "g1", name: "flour", quantity: 2, unit: "cup", ingredientId: "iOld" })],
    );
    expect(p.toUpdate).toEqual([{ id: "g1", quantity: 3, ingredientId: "i1" }]);
    expect(p.toInsert).toHaveLength(0);
    expect(p.added).toBe(0);
    expect(p.removed).toBe(0);
  });

  it("leaves a surviving auto-row alone when quantity is unchanged", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "flour", quantity: 2, unit: "cup" }],
      [auto({ id: "g1", name: "flour", quantity: 2, unit: "cup" })],
    );
    expect(p.toUpdate).toHaveLength(0);
    expect(p.toInsert).toHaveLength(0);
    expect(p.toDelete).toHaveLength(0);
  });

  it("clears a surviving auto-row's quantity when the slotting is now unquantified", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "flour", quantity: null, unit: "cup" }],
      [auto({ id: "g1", name: "flour", quantity: 2, unit: "cup" })],
    );
    expect(p.toUpdate).toEqual([{ id: "g1", quantity: null, ingredientId: "i1" }]);
  });

  it("deletes an untouched auto-row whose source is no longer slotted", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "flour", quantity: 2, unit: "cup" }],
      [
        auto({ id: "g1", name: "flour", quantity: 2, unit: "cup" }),
        auto({ id: "g2", name: "sugar", quantity: 1, unit: "cup" }),
      ],
    );
    expect(p.toDelete).toEqual(["g2"]);
    expect(p.removed).toBe(1);
  });

  it("deletes EVERY stale untouched auto-row sharing a no-longer-slotted key", () => {
    const p = planRollup(
      [],
      [
        auto({ id: "g1", name: "sugar", quantity: 1, unit: "cup" }),
        auto({ id: "g2", name: "Sugar", quantity: 2, unit: "cup" }),
      ],
    );
    expect(p.toDelete.sort()).toEqual(["g1", "g2"]);
    expect(p.removed).toBe(2);
  });

  it("refreshes only one of duplicate auto-rows for a still-slotted key (never deletes it)", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "sugar", quantity: 3, unit: "cup" }],
      [
        auto({ id: "g1", name: "sugar", quantity: 1, unit: "cup" }),
        auto({ id: "g2", name: "sugar", quantity: 1, unit: "cup" }),
      ],
    );
    expect(p.toUpdate).toEqual([{ id: "g1", quantity: 3, ingredientId: "i1" }]);
    expect(p.toDelete).toHaveLength(0);
  });

  it.each(["edited", "checked", "haveIt"] as const)(
    "never deletes a %s row even when its source is gone",
    (flag) => {
      const p = planRollup(
        [],
        [auto({ id: "g1", name: "sugar", quantity: 1, unit: "cup", [flag]: true })],
      );
      expect(p.toDelete).toHaveLength(0);
      expect(p.removed).toBe(0);
    },
  );

  it("never deletes an ad-hoc row (ingredientId null)", () => {
    const p = planRollup([], [auto({ id: "g1", name: "chips", ingredientId: null })]);
    expect(p.toDelete).toHaveLength(0);
  });

  it.each(["edited", "checked", "haveIt"] as const)(
    "does not insert/update an auto-row for a key a %s row owns — merge not clobber",
    (flag) => {
      const p = planRollup(
        [{ ingredientId: "i1", name: "flour", quantity: 3, unit: "cup" }],
        [auto({ id: "g1", name: "flour", quantity: 5, unit: "cup", [flag]: true })],
      );
      expect(p.toInsert).toHaveLength(0);
      expect(p.toUpdate).toHaveLength(0);
      expect(p.toDelete).toHaveLength(0);
      expect(p.added).toBe(0);
      expect(p.removed).toBe(0);
    },
  );

  it("does not insert an auto-row for a key an ad-hoc row owns", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "chips", quantity: 1, unit: null }],
      [auto({ id: "g1", name: "chips", ingredientId: null })],
    );
    expect(p.toInsert).toHaveLength(0);
    expect(p.toUpdate).toHaveLength(0);
  });

  it("does not let a protected row shield a DIFFERENT key from being inserted", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "flour", quantity: 3, unit: "g" }],
      [auto({ id: "g1", name: "flour", quantity: 5, unit: "cup", edited: true })],
    );
    expect(p.toInsert).toEqual([{ name: "flour", quantity: 3, unit: "g", ingredientId: "i1" }]);
    expect(p.added).toBe(1);
  });

  it("still deletes an untouched auto-row that shares a name with a protected row", () => {
    const p = planRollup(
      [],
      [
        auto({ id: "g1", name: "flour", quantity: 5, unit: "cup", edited: true }),
        auto({ id: "g2", name: "flour", quantity: 1, unit: "g" }),
      ],
    );
    expect(p.toDelete).toEqual(["g2"]);
  });

  it("inserts a brand-new auto-row and counts it added", () => {
    const p = planRollup([{ ingredientId: "i1", name: "butter", quantity: 1, unit: "stick" }], []);
    expect(p.added).toBe(1);
    expect(p.toInsert[0].ingredientId).toBe("i1");
  });

  it("returns an empty plan for an empty week and an empty list", () => {
    expect(planRollup([], [])).toEqual({
      toInsert: [],
      toUpdate: [],
      toDelete: [],
      added: 0,
      removed: 0,
    });
  });

  it("reports added/removed as the sizes of the insert/delete sets", () => {
    const p = planRollup(
      [
        { ingredientId: "i1", name: "butter", quantity: 1, unit: "stick" },
        { ingredientId: "i2", name: "basil", quantity: null, unit: null },
      ],
      [
        auto({ id: "g1", name: "sugar", quantity: 1, unit: "cup" }),
        auto({ id: "g2", name: "rice", quantity: 1, unit: "cup" }),
      ],
    );
    expect(p.added).toBe(p.toInsert.length);
    expect(p.removed).toBe(p.toDelete.length);
    expect(p.added).toBe(2);
    expect(p.removed).toBe(2);
  });
});
