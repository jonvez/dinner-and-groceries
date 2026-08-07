import { describe, expect, it, vi } from "vitest";

import {
  addAdHocItem,
  addCatalogItemToList,
  setChecked,
  setHaveIt,
} from "./mutations-core";

/**
 * The four shopper edits (issue #15): one-tap staple, typed ad-hoc item, "we
 * already have it", and check-off. Each takes an INJECTED Supabase-like client
 * (no live DB) and is asserted at the STATEMENT level — the payload is the
 * contract, because that is what RLS and the three-feeder model are checked
 * against.
 *
 * Security notes pinned by these tests:
 *   - every insert carries the CALLER'S `household_id` (from the verified
 *     session, never form input), so the `with check` policy applies (#13);
 *   - the toggles write ONLY their own column — a crafted call can't smuggle in
 *     a household re-home or flip `edited`;
 *   - a cross-household `catalogItemId` simply reads back nothing under RLS, so
 *     the add fails closed instead of inserting a row with a foreign name.
 */

type QueryResult = { data: unknown; error: unknown };

type Filter = { op: string; column: string; value: unknown };

type Recorded = {
  selects: { table: string; columns: string; filters: Filter[] }[];
  inserts: { table: string; rows: unknown }[];
  updates: { table: string; values: unknown; filters: Filter[] }[];
};

function makeClient(opts: { catalogItem?: QueryResult; insert?: QueryResult; update?: QueryResult } = {}) {
  const calls: Recorded = { selects: [], inserts: [], updates: [] };
  const ok: QueryResult = { data: null, error: null };

  const from = vi.fn((table: string) => ({
    select: (columns: string) => {
      const filters: Filter[] = [];
      const builder = {
        eq(column: string, value: unknown) {
          filters.push({ op: "eq", column, value });
          return builder;
        },
        maybeSingle() {
          calls.selects.push({ table, columns, filters });
          return Promise.resolve(opts.catalogItem ?? ok);
        },
      };
      return builder;
    },
    insert: (rows: unknown) => {
      calls.inserts.push({ table, rows });
      return Promise.resolve(opts.insert ?? ok);
    },
    update: (values: unknown) => {
      const filters: Filter[] = [];
      const builder = {
        eq(column: string, value: unknown) {
          filters.push({ op: "eq", column, value });
          return builder;
        },
        then<T>(resolve: (r: QueryResult) => T) {
          calls.updates.push({ table, values, filters });
          return Promise.resolve(opts.update ?? ok).then(resolve);
        },
      };
      return builder;
    },
  }));

  const client = { from } as unknown as Parameters<typeof addAdHocItem>[0];
  return { client, calls };
}

const NOW = new Date("2026-08-07T18:30:00.000Z");
const now = () => NOW;

describe("addCatalogItemToList", () => {
  it("inserts a catalog-fed row copying the staple's name + default unit", async () => {
    const { client, calls } = makeClient({
      catalogItem: {
        data: { id: "c1", name: "Olive oil", default_unit: "bottle", added_count: 4 },
        error: null,
      },
    });

    const result = await addCatalogItemToList(client, {
      householdId: "hh-1",
      weekId: "wk-1",
      catalogItemId: "c1",
      now,
    });

    expect(result).toEqual({ ok: true });
    expect(calls.inserts).toEqual([
      {
        table: "grocery_items",
        rows: {
          household_id: "hh-1",
          week_id: "wk-1",
          name: "Olive oil",
          quantity: null,
          unit: "bottle",
          catalog_item_id: "c1",
          ingredient_id: null,
        },
      },
    ]);
  });

  it("bumps the staple's added_count and last_added_at", async () => {
    const { client, calls } = makeClient({
      catalogItem: {
        data: { id: "c1", name: "Milk", default_unit: null, added_count: 4 },
        error: null,
      },
    });

    await addCatalogItemToList(client, {
      householdId: "hh-1",
      weekId: "wk-1",
      catalogItemId: "c1",
      now,
    });

    expect(calls.updates).toEqual([
      {
        table: "catalog_items",
        values: { added_count: 5, last_added_at: NOW.toISOString() },
        filters: [{ op: "eq", column: "id", value: "c1" }],
      },
    ]);
  });

  it("fails closed when the staple is not readable (another household's id)", async () => {
    const { client, calls } = makeClient({ catalogItem: { data: null, error: null } });

    const result = await addCatalogItemToList(client, {
      householdId: "hh-1",
      weekId: "wk-1",
      catalogItemId: "other-household-item",
      now,
    });

    expect(result).toEqual({ ok: false, error: "Could not update the list." });
    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  it("reports a generic error when the insert is denied", async () => {
    const { client } = makeClient({
      catalogItem: {
        data: { id: "c1", name: "Milk", default_unit: null, added_count: 0 },
        error: null,
      },
      insert: { data: null, error: { message: "violates row-level security policy" } },
    });

    expect(
      await addCatalogItemToList(client, {
        householdId: "hh-1",
        weekId: "wk-1",
        catalogItemId: "c1",
        now,
      }),
    ).toEqual({ ok: false, error: "Could not update the list." });
  });
});

describe("addAdHocItem", () => {
  it("inserts a row with BOTH feeder FKs null", async () => {
    const { client, calls } = makeClient();

    const result = await addAdHocItem(client, {
      householdId: "hh-1",
      weekId: "wk-1",
      name: "paper towels",
      quantity: 2,
      unit: "packs",
    });

    expect(result).toEqual({ ok: true });
    expect(calls.inserts).toEqual([
      {
        table: "grocery_items",
        rows: {
          household_id: "hh-1",
          week_id: "wk-1",
          name: "paper towels",
          quantity: 2,
          unit: "packs",
          ingredient_id: null,
          catalog_item_id: null,
        },
      },
    ]);
  });

  it("preserves a null quantity/unit (a bare name is valid — never 0 or 1)", async () => {
    const { client, calls } = makeClient();

    await addAdHocItem(client, {
      householdId: "hh-1",
      weekId: "wk-1",
      name: "eggs",
      quantity: null,
      unit: null,
    });

    const rows = calls.inserts[0].rows as { quantity: unknown; unit: unknown };
    expect(rows.quantity).toBeNull();
    expect(rows.unit).toBeNull();
  });

  it("trims the name and rejects a blank one before touching the DB", async () => {
    const { client, calls } = makeClient();

    await addAdHocItem(client, {
      householdId: "hh-1",
      weekId: "wk-1",
      name: "  bananas  ",
      quantity: null,
      unit: null,
    });
    expect((calls.inserts[0].rows as { name: string }).name).toBe("bananas");

    const blank = await addAdHocItem(client, {
      householdId: "hh-1",
      weekId: "wk-1",
      name: "   ",
      quantity: null,
      unit: null,
    });
    expect(blank).toEqual({ ok: false, error: "Give the item a name." });
    expect(calls.inserts).toHaveLength(1);
  });

  it("drops a non-finite quantity rather than storing NaN", async () => {
    const { client, calls } = makeClient();

    await addAdHocItem(client, {
      householdId: "hh-1",
      weekId: "wk-1",
      name: "milk",
      quantity: Number.NaN,
      unit: null,
    });

    expect((calls.inserts[0].rows as { quantity: unknown }).quantity).toBeNull();
  });
});

describe("setHaveIt / setChecked", () => {
  it("have-it updates only have_it, by id", async () => {
    const { client, calls } = makeClient();

    const result = await setHaveIt(client, { id: "g1", haveIt: true });

    expect(result).toEqual({ ok: true });
    expect(calls.updates).toEqual([
      {
        table: "grocery_items",
        values: { have_it: true },
        filters: [{ op: "eq", column: "id", value: "g1" }],
      },
    ]);
  });

  it("check-off updates only checked, by id", async () => {
    const { client, calls } = makeClient();

    await setChecked(client, { id: "g1", checked: true });

    expect(calls.updates).toEqual([
      {
        table: "grocery_items",
        values: { checked: true },
        filters: [{ op: "eq", column: "id", value: "g1" }],
      },
    ]);
  });

  it("surfaces a generic error when the update is denied (cross-household id)", async () => {
    const { client } = makeClient({
      update: { data: null, error: { message: "permission denied" } },
    });

    expect(await setChecked(client, { id: "foreign", checked: true })).toEqual({
      ok: false,
      error: "Could not update the list.",
    });
  });
});
