import { describe, it, expect } from "vitest";

import { parseIngredient } from "@/lib/recipes/ingredient";

import {
  planBackfill,
  readExportedRows,
  renderBackfillSql,
  type IngredientExportRow,
} from "./ingredient-name-backfill";

/**
 * The #170 backfill's pure half. The REAL parser is injected in every test, so
 * these assertions are about what the script does with a parse — the parsing
 * rules themselves are never forked into this script or into SQL.
 */

const AT = "2026-09-07T00:00:00.000Z";
const ID = "11111111-1111-4111-8111-111111111111";

function row(over: Partial<IngredientExportRow> = {}): IngredientExportRow {
  return {
    id: ID,
    raw_text: "- 2 cups all-purpose flour",
    name: "- 2 cups all-purpose flour",
    quantity: null,
    unit: null,
    ...over,
  };
}

describe("planBackfill", () => {
  it("re-parses raw_text and plans the repair a polluted row needs", () => {
    const plan = planBackfill([row()], parseIngredient);

    expect(plan.updates).toEqual([
      {
        id: ID,
        prevName: "- 2 cups all-purpose flour",
        name: "all-purpose flour",
        quantity: 2,
        unit: "cup",
      },
    ]);
  });

  it("NEVER touches a row whose raw_text is null, empty or whitespace", () => {
    const plan = planBackfill(
      [
        row({ id: "a", raw_text: null }),
        row({ id: "b", raw_text: "" }),
        row({ id: "c", raw_text: "  \t " }),
      ],
      parseIngredient,
    );

    expect(plan.updates).toEqual([]);
    expect(plan.skipped.missingRawText).toBe(3);
  });

  it("NEVER blanks a name: falls back to the raw line exactly as the ingest path does", () => {
    // A line that is nothing but a marker parses to an empty name, and the
    // column is NOT NULL + non-empty. Same fallback rule as ingredientRowsFromText.
    const plan = planBackfill([row({ raw_text: "•", name: "stale" })], parseIngredient);

    expect(plan.updates).toEqual([
      { id: ID, prevName: "stale", name: "•", quantity: null, unit: null },
    ]);
  });

  it("leaves an already-correct row alone", () => {
    const plan = planBackfill(
      [row({ raw_text: "2 cups flour", name: "flour", quantity: 2, unit: "cup" })],
      parseIngredient,
    );

    expect(plan.updates).toEqual([]);
    expect(plan.skipped.unchanged).toBe(1);
  });

  it("compares a numeric quantity that came back from Postgres as a string", () => {
    // `numeric` arrives as a string in JSON; a naive === would plan an update
    // for every already-correct row in the table.
    const plan = planBackfill(
      [row({ raw_text: "2 cups flour", name: "flour", quantity: "2.0", unit: "cup" })],
      parseIngredient,
    );

    expect(plan.updates).toEqual([]);
    expect(plan.skipped.unchanged).toBe(1);
  });

  it("plans a repair when only the quantity or unit is wrong", () => {
    const plan = planBackfill(
      [row({ raw_text: "2lb pork shoulder", name: "pork shoulder" })],
      parseIngredient,
    );

    expect(plan.updates).toMatchObject([
      { name: "pork shoulder", quantity: 2, unit: "lb" },
    ]);
  });

  it("reports totals so the operator can sanity-check the blast radius", () => {
    const plan = planBackfill(
      [
        row({ id: "a" }),
        row({ id: "b", raw_text: null }),
        row({ id: "c", raw_text: "2 cups flour", name: "flour", quantity: 2, unit: "cup" }),
      ],
      parseIngredient,
    );

    expect(plan.total).toBe(3);
    expect(plan.updates).toHaveLength(1);
    expect(plan.skipped).toEqual({ missingRawText: 1, unchanged: 1 });
  });
});

describe("renderBackfillSql", () => {
  it("wraps the whole repair in ONE transaction with a row-count guard", () => {
    const sql = renderBackfillSql(planBackfill([row()], parseIngredient), { generatedAt: AT });

    expect(sql).toContain("begin;");
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("raise exception");
    expect(sql).toContain(AT);
  });

  it("carries every constraint from the issue into the UPDATE itself", () => {
    const sql = renderBackfillSql(planBackfill([row()], parseIngredient), { generatedAt: AT });

    // Never a null/empty raw_text, never a blank name, and never a row somebody
    // edited between the export and the run.
    expect(sql).toContain("update public.ingredients as i");
    expect(sql).toContain("i.raw_text is not null");
    expect(sql).toContain("btrim(i.raw_text) <> ''");
    expect(sql).toContain("btrim(b.name) <> ''");
    expect(sql).toContain("i.name = b.prev_name");
  });

  it("escapes single quotes so a real ingredient name cannot break (or inject) SQL", () => {
    const nasty = "1 cup Bob's sauce'); drop table public.ingredients;--";
    const parsedName = parseIngredient(nasty).name;
    const sql = renderBackfillSql(
      planBackfill([row({ raw_text: nasty, name: "stale" })], parseIngredient),
      { generatedAt: AT },
    );

    expect(sql).toContain(parsedName.replace(/'/g, "''"));
    expect(sql).not.toContain("sauce'); drop");
  });

  it("renders a null quantity and unit as SQL null, not the string 'null'", () => {
    const sql = renderBackfillSql(
      planBackfill([row({ raw_text: "- Kosher salt", name: "- Kosher salt" })], parseIngredient),
      { generatedAt: AT },
    );

    expect(sql).toContain("'Kosher salt', null, null");
  });

  it("emits a harmless no-op when there is nothing to repair", () => {
    const sql = renderBackfillSql(
      planBackfill(
        [row({ raw_text: "2 cups flour", name: "flour", quantity: 2, unit: "cup" })],
        parseIngredient,
      ),
      { generatedAt: AT },
    );

    expect(sql).not.toContain("update public.ingredients");
    expect(sql).toContain("nothing to repair");
  });
});

describe("readExportedRows", () => {
  const good = [{ id: "a", raw_text: "- 2 cups flour", name: "- 2 cups flour", quantity: null, unit: null }];

  it("accepts a bare json array of rows", () => {
    expect(readExportedRows(good)).toEqual(good);
  });

  it("unwraps the shapes a `select … as rows` actually returns", () => {
    expect(readExportedRows({ rows: good })).toEqual(good);
    expect(readExportedRows([{ rows: good }])).toEqual(good);
    expect(readExportedRows({ data: good })).toEqual(good);
  });

  it("refuses an export it cannot find rows in, rather than backfilling nothing", () => {
    expect(() => readExportedRows({ nope: 1 })).toThrow(/rows/i);
    expect(() => readExportedRows("[]")).toThrow(/rows/i);
  });

  it("refuses a row missing the id or name the guards depend on", () => {
    expect(() => readExportedRows([{ raw_text: "x", name: "x" }])).toThrow(/id/i);
    expect(() => readExportedRows([{ id: "a", raw_text: "x" }])).toThrow(/name/i);
  });

  it("accepts an empty export", () => {
    expect(readExportedRows([])).toEqual([]);
  });
});
