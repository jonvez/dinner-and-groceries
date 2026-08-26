import { describe, expect, it, vi } from "vitest";

import { loadGroceryList } from "./list-core";

/**
 * `loadGroceryList` is the read half of the `/grocery` page (issue #15): the
 * ACTIVE list for a week plus the household's staples catalog. Tested over an
 * INJECTED Supabase-like client — no live DB (same pattern as `rollup-core`).
 *
 * What's pinned here:
 *   - only the week's UN-PURCHASED rows are the active list (`purchased_at is
 *     null`) — a completed trip's rows must never reappear;
 *   - stable shopping order (`position`, then `created_at`) and a
 *     most-used-first catalog (`added_count desc`, then `name`);
 *   - snake_case → camelCase mapping, so a `have_it` row really is de-emphasized
 *     and a dish-derived row really is marked in the UI;
 *   - quantity/unit stay NULL (never coerced to 0/1 — the list must render an
 *     unquantified "eggs" as just "eggs");
 *   - no rows / a failed read degrades to empty arrays rather than throwing.
 *
 * Household scoping is RLS's job (#13) — there is deliberately no household_id
 * filter here; `weekId` only narrows what RLS already scopes.
 */

type QueryResult = { data: unknown; error: unknown };

type Filter = { op: string; column: string; value?: unknown; options?: unknown };

type Recorded = {
  table: string;
  columns: string;
  filters: Filter[];
};

function makeClient(opts: { items?: QueryResult; catalog?: QueryResult }) {
  const selects: Recorded[] = [];
  const empty: QueryResult = { data: [], error: null };

  const from = vi.fn((table: string) => ({
    select: (columns: string) => {
      const filters: Filter[] = [];
      const result =
        table === "grocery_items" ? (opts.items ?? empty) : (opts.catalog ?? empty);
      const builder = {
        eq(column: string, value: unknown) {
          filters.push({ op: "eq", column, value });
          return builder;
        },
        is(column: string, value: unknown) {
          filters.push({ op: "is", column, value });
          return builder;
        },
        order(column: string, options?: unknown) {
          filters.push({ op: "order", column, options });
          return builder;
        },
        then<T>(resolve: (r: QueryResult) => T) {
          selects.push({ table, columns, filters });
          return Promise.resolve(result).then(resolve);
        },
      };
      return builder;
    },
  }));

  const client = { from } as unknown as Parameters<typeof loadGroceryList>[0];
  return { client, selects };
}

const itemRow = (o: Record<string, unknown> & { id: string; name: string }) => ({
  quantity: null,
  unit: null,
  ingredient_id: null,
  catalog_item_id: null,
  have_it: false,
  checked: false,
  edited: false,
  position: 0,
  created_at: "2026-08-07T00:00:00.000Z",
  ...o,
});

describe("loadGroceryList", () => {
  it("reads every un-purchased row, in shopping order — NOT just this week's", async () => {
    // The list is a rolling list. Scoping it to the current week silently hid
    // everything the family added before the week rolled over (2026-08-24):
    // the rows were never deleted, just unreachable, which reads as data loss.
    const { client, selects } = makeClient({});

    await loadGroceryList(client);

    const items = selects.find((s) => s.table === "grocery_items");
    expect(items?.filters).toEqual([
      { op: "is", column: "purchased_at", value: null },
      { op: "order", column: "position", options: undefined },
      { op: "order", column: "created_at", options: undefined },
    ]);
    expect(items?.filters.some((f) => f.column === "week_id")).toBe(false);
    // No manual household filter — RLS scopes the read (ADR 0003).
    expect(items?.filters.some((f) => f.column === "household_id")).toBe(false);
  });

  it("reads the staples catalog most-used first, then alphabetically", async () => {
    const { client, selects } = makeClient({});

    await loadGroceryList(client);

    const catalog = selects.find((s) => s.table === "catalog_items");
    expect(catalog?.columns).toContain("default_unit");
    expect(catalog?.filters).toEqual([
      { op: "order", column: "added_count", options: { ascending: false } },
      { op: "order", column: "name", options: undefined },
    ]);
  });

  it("maps snake_case columns onto the view shape", async () => {
    const { client } = makeClient({
      items: {
        data: [
          itemRow({
            id: "g1",
            name: "Flour",
            quantity: 2,
            unit: "cup",
            ingredient_id: "ing-1",
            have_it: true,
            checked: true,
            edited: true,
            position: 3,
            created_at: "2026-08-06T12:00:00.000Z",
          }),
        ],
        error: null,
      },
      catalog: {
        data: [
          { id: "c1", name: "Olive oil", default_unit: "bottle", added_count: 3 },
          // A row that predates the column default: null must read as 0, never
          // NaN, because the chip threshold and suggestion ranking compare it.
          { id: "c2", name: "Salt", default_unit: null, added_count: null },
        ],
        error: null,
      },
    });

    const { items, catalog } = await loadGroceryList(client);

    expect(items).toEqual([
      {
        id: "g1",
        name: "Flour",
        quantity: 2,
        unit: "cup",
        ingredientId: "ing-1",
        catalogItemId: null,
        haveIt: true,
        checked: true,
        edited: true,
        position: 3,
        createdAt: "2026-08-06T12:00:00.000Z",
      },
    ]);
    expect(catalog).toEqual([
      { id: "c1", name: "Olive oil", defaultUnit: "bottle", addedCount: 3 },
      { id: "c2", name: "Salt", defaultUnit: null, addedCount: 0 },
    ]);
  });

  it("keeps an unquantified item unquantified (never 0 or 1)", async () => {
    const { client } = makeClient({
      items: { data: [itemRow({ id: "g1", name: "eggs" })], error: null },
    });

    const { items } = await loadGroceryList(client);

    expect(items[0].quantity).toBeNull();
    expect(items[0].unit).toBeNull();
  });

  it("returns empty arrays when there are no rows", async () => {
    const { client } = makeClient({
      items: { data: null, error: null },
      catalog: { data: null, error: null },
    });

    expect(await loadGroceryList(client)).toEqual({
      items: [],
      catalog: [],
      sections: [],
    });
  });

  it("degrades to empty arrays when a read fails (page still renders)", async () => {
    const { client } = makeClient({
      items: { data: null, error: { message: "permission denied" } },
      catalog: { data: null, error: { message: "permission denied" } },
    });

    expect(await loadGroceryList(client)).toEqual({
      items: [],
      catalog: [],
      sections: [],
    });
  });
});
