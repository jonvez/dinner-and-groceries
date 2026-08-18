import { describe, expect, it, vi } from "vitest";

import { buildGroceryList } from "./rollup-core";

/**
 * `buildGroceryList` is the only I/O around the pure planner (issue #14): it
 * reads the week's slotted dishes → their ingredient lines, reads the ACTIVE
 * grocery list, and applies the plan. Tested over an INJECTED Supabase-like
 * client — no live DB. The planner's merge rules are proven in
 * `lib/grocery/rollup.test.ts`; here we pin the wiring:
 *   - the read is week-scoped, and only the un-purchased list is considered;
 *   - a dish slotted twice contributes its ingredient lines twice;
 *   - snake_case rows map onto the planner's shape, so `have_it` /
 *     `ingredient_id: null` rows really are protected end-to-end;
 *   - writes carry `household_id` from the CALLER'S args (never form input);
 *   - every failure collapses to one generic error.
 */

type QueryResult = { data: unknown; error: unknown };

type Filter = { op: string; column: string; value: unknown };

type Recorded = {
  selects: { table: string; columns: string; filters: Filter[] }[];
  inserts: { table: string; rows: unknown }[];
  updates: { table: string; values: unknown; filters: Filter[] }[];
  deletes: { table: string; filters: Filter[] }[];
};

function makeClient(opts: {
  slots?: QueryResult;
  groceryItems?: QueryResult;
  insert?: QueryResult;
  update?: QueryResult;
  delete?: QueryResult;
}) {
  const calls: Recorded = { selects: [], inserts: [], updates: [], deletes: [] };
  const ok: QueryResult = { data: null, error: null };

  const thenable = (result: QueryResult, record: (filters: Filter[]) => void) => {
    const filters: Filter[] = [];
    const builder = {
      eq(column: string, value: unknown) {
        filters.push({ op: "eq", column, value });
        return builder;
      },
      is(column: string, value: unknown) {
        filters.push({ op: "is", column, value });
        return builder;
      },
      in(column: string, value: unknown) {
        filters.push({ op: "in", column, value });
        return builder;
      },
      then<T>(resolve: (r: QueryResult) => T) {
        record(filters);
        return Promise.resolve(result).then(resolve);
      },
    };
    return builder;
  };

  const from = vi.fn((table: string) => ({
    select: (columns: string) => {
      const result = table === "slots" ? (opts.slots ?? ok) : (opts.groceryItems ?? ok);
      return thenable(result, (filters) => calls.selects.push({ table, columns, filters }));
    },
    insert: (rows: unknown) => {
      calls.inserts.push({ table, rows });
      return Promise.resolve(opts.insert ?? ok);
    },
    update: (values: unknown) =>
      thenable(opts.update ?? ok, (filters) => calls.updates.push({ table, values, filters })),
    delete: () =>
      thenable(opts.delete ?? ok, (filters) => calls.deletes.push({ table, filters })),
  }));

  const client = { from } as unknown as Parameters<typeof buildGroceryList>[0];
  return { client, calls };
}

/** One slot holding `dishes`, each dish being a list of ingredient rows. */
const slotRow = (
  ...dishes: { id: string; name: string; quantity: number | null; unit: string | null }[][]
) => ({ slot_dishes: dishes.map((ingredients) => ({ dish: { ingredients } })) });

const groceryRow = (o: Record<string, unknown> & { id: string; name: string }) => ({
  quantity: null,
  unit: null,
  ingredient_id: "ing-x",
  section_id: null,
  catalog_item_id: null,
  have_it: false,
  checked: false,
  edited: false,
  ...o,
});

const ARGS = { householdId: "hh-1", weekId: "wk-1" };

describe("buildGroceryList", () => {
  it("reads this week's slots and only the un-purchased grocery rows", async () => {
    const { client, calls } = makeClient({
      slots: { data: [], error: null },
      groceryItems: { data: [], error: null },
    });

    await buildGroceryList(client, ARGS);

    const slotSelect = calls.selects.find((s) => s.table === "slots");
    expect(slotSelect?.columns).toContain("slot_dishes");
    expect(slotSelect?.filters).toEqual([{ op: "eq", column: "week_id", value: "wk-1" }]);

    const listSelect = calls.selects.find((s) => s.table === "grocery_items");
    expect(listSelect?.filters).toEqual([
      { op: "eq", column: "week_id", value: "wk-1" },
      { op: "is", column: "purchased_at", value: null },
    ]);
  });

  it("rolls a dish slotted twice up twice and inserts household/week-scoped rows", async () => {
    const flour = [{ id: "ing-1", name: "Flour", quantity: 2, unit: "cup" }];
    const { client, calls } = makeClient({
      // Same dish in two different slots.
      slots: { data: [slotRow(flour), slotRow(flour)], error: null },
      groceryItems: { data: [], error: null },
    });

    const result = await buildGroceryList(client, ARGS);

    expect(calls.inserts).toEqual([
      {
        table: "grocery_items",
        rows: [
          {
            household_id: "hh-1",
            week_id: "wk-1",
            name: "Flour",
            quantity: 4,
            unit: "cup",
            ingredient_id: "ing-1",
            section_id: null,
          },
        ],
      },
    ]);
    expect(result).toEqual({ ok: true, added: 1, removed: 0 });
  });

  it("flattens every ingredient of every slotted dish", async () => {
    const { client, calls } = makeClient({
      slots: {
        data: [
          slotRow(
            [
              { id: "ing-1", name: "flour", quantity: 1, unit: "cup" },
              { id: "ing-2", name: "eggs", quantity: null, unit: null },
            ],
            [{ id: "ing-3", name: "butter", quantity: 1, unit: "stick" }],
          ),
        ],
        error: null,
      },
      groceryItems: { data: [], error: null },
    });

    const result = await buildGroceryList(client, ARGS);

    expect((calls.inserts[0].rows as { name: string }[]).map((r) => r.name)).toEqual([
      "flour",
      "eggs",
      "butter",
    ]);
    expect(result).toEqual({ ok: true, added: 3, removed: 0 });
  });

  it("maps snake_case rows so a have_it row is protected (never re-inserted)", async () => {
    const { client, calls } = makeClient({
      slots: {
        data: [slotRow([{ id: "ing-1", name: "flour", quantity: 3, unit: "cup" }])],
        error: null,
      },
      groceryItems: {
        data: [
          groceryRow({ id: "g1", name: "flour", quantity: 1, unit: "cup", have_it: true }),
        ],
        error: null,
      },
    });

    const result = await buildGroceryList(client, ARGS);

    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
    expect(result).toEqual({ ok: true, added: 0, removed: 0 });
  });

  it("treats a catalog row (ingredient_id null) as protected", async () => {
    const { client, calls } = makeClient({
      slots: {
        data: [slotRow([{ id: "ing-1", name: "olive oil", quantity: 1, unit: null }])],
        error: null,
      },
      groceryItems: {
        data: [
          groceryRow({
            id: "g1",
            name: "olive oil",
            ingredient_id: null,
            catalog_item_id: "c1",
          }),
        ],
        error: null,
      },
    });

    await buildGroceryList(client, ARGS);

    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
  });

  it("refreshes a surviving auto-row by id and deletes stale ones in one statement", async () => {
    const { client, calls } = makeClient({
      slots: {
        data: [slotRow([{ id: "ing-9", name: "flour", quantity: 3, unit: "cup" }])],
        error: null,
      },
      groceryItems: {
        data: [
          groceryRow({ id: "g1", name: "flour", quantity: 1, unit: "cup", ingredient_id: "old" }),
          groceryRow({ id: "g2", name: "sugar", quantity: 1, unit: "cup" }),
        ],
        error: null,
      },
    });

    const result = await buildGroceryList(client, ARGS);

    expect(calls.updates).toEqual([
      {
        table: "grocery_items",
        values: { quantity: 3, ingredient_id: "ing-9" },
        filters: [{ op: "eq", column: "id", value: "g1" }],
      },
    ]);
    expect(calls.deletes).toEqual([
      { table: "grocery_items", filters: [{ op: "in", column: "id", value: ["g2"] }] },
    ]);
    // A quantity refresh is neither added nor removed.
    expect(result).toEqual({ ok: true, added: 0, removed: 1 });
  });

  it("issues no insert or delete statement when the plan has none", async () => {
    const { client, calls } = makeClient({
      slots: {
        data: [slotRow([{ id: "ing-1", name: "flour", quantity: 1, unit: "cup" }])],
        error: null,
      },
      groceryItems: {
        data: [groceryRow({ id: "g1", name: "flour", quantity: 1, unit: "cup" })],
        error: null,
      },
    });

    const result = await buildGroceryList(client, ARGS);

    expect(calls.inserts).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
    expect(result).toEqual({ ok: true, added: 0, removed: 0 });
  });

  it("tolerates a week with no slots and a null embed", async () => {
    const { client } = makeClient({
      slots: { data: [{ slot_dishes: null }, slotRow()], error: null },
      groceryItems: { data: null, error: null },
    });

    expect(await buildGroceryList(client, ARGS)).toEqual({
      ok: true,
      added: 0,
      removed: 0,
    });
  });

  it("returns a generic error when the slots read fails, writing nothing", async () => {
    const { client, calls } = makeClient({
      slots: { data: null, error: { message: 'relation "slots" does not exist' } },
      groceryItems: { data: [], error: null },
    });

    const result = await buildGroceryList(client, ARGS);

    expect(result).toEqual({ ok: false, error: "Could not build the grocery list." });
    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
  });

  it("returns a generic error when the grocery-list read fails, writing nothing", async () => {
    const { client, calls } = makeClient({
      slots: {
        data: [slotRow([{ id: "ing-1", name: "flour", quantity: 1, unit: "cup" }])],
        error: null,
      },
      groceryItems: { data: null, error: { message: "permission denied" } },
    });

    const result = await buildGroceryList(client, ARGS);

    expect(result).toEqual({ ok: false, error: "Could not build the grocery list." });
    expect(calls.inserts).toHaveLength(0);
  });

  it("returns a generic error when applying the plan fails (RLS denial)", async () => {
    const { client } = makeClient({
      slots: {
        data: [slotRow([{ id: "ing-1", name: "flour", quantity: 1, unit: "cup" }])],
        error: null,
      },
      groceryItems: { data: [], error: null },
      insert: { data: null, error: { message: "new row violates row-level security policy" } },
    });

    expect(await buildGroceryList(client, ARGS)).toEqual({
      ok: false,
      error: "Could not build the grocery list.",
    });
  });
});
