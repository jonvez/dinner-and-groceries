import { describe, expect, it, vi } from "vitest";

import { completeTrip, promoteToCatalog } from "./trip-core";

/**
 * Finishing a shopping trip (issue #15): soft-archive what's in the cart, then
 * offer the newly-typed items for promotion into the staples catalog. Injected
 * Supabase-like client — no live DB.
 *
 * What's pinned:
 *   - archive touches ONLY this week's checked, not-yet-purchased rows (an
 *     un-checked item survives to the next trip; an already-archived row is
 *     never re-stamped);
 *   - only AD-HOC rows (both feeder FKs null) are promotion candidates — a
 *     dish-derived line isn't a staple, and a catalog-fed row already is one;
 *   - promotion is case-insensitively idempotent ("Olive Oil" bumps the existing
 *     "olive oil" rather than creating a twin), matching the
 *     `(household_id, lower(name))` unique index;
 *   - promotion writes `household_id` from the CALLER'S verified session and
 *     also filters the lookup by it (defense in depth over RLS);
 *   - LIKE metacharacters in a typed name are escaped, so "50% cream" can't
 *     wildcard-match a different staple.
 */

type QueryResult = { data: unknown; error: unknown };

type Filter = { op: string; column: string; value: unknown };

type Recorded = {
  selects: { table: string; columns: string; filters: Filter[] }[];
  inserts: { table: string; rows: unknown }[];
  updates: { table: string; values: unknown; filters: Filter[]; returning?: string }[];
};

function makeClient(opts: {
  archived?: QueryResult;
  /** Sequential answers for the per-name catalog lookup. */
  lookups?: QueryResult[];
  insert?: QueryResult;
  update?: QueryResult;
} = {}) {
  const calls: Recorded = { selects: [], inserts: [], updates: [] };
  const ok: QueryResult = { data: null, error: null };
  const lookups = [...(opts.lookups ?? [])];

  const from = vi.fn((table: string) => ({
    select: (columns: string) => {
      const filters: Filter[] = [];
      const builder = {
        eq(column: string, value: unknown) {
          filters.push({ op: "eq", column, value });
          return builder;
        },
        ilike(column: string, value: unknown) {
          filters.push({ op: "ilike", column, value });
          return builder;
        },
        maybeSingle() {
          calls.selects.push({ table, columns, filters });
          return Promise.resolve(lookups.shift() ?? ok);
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
        is(column: string, value: unknown) {
          filters.push({ op: "is", column, value });
          return builder;
        },
        select(columns: string) {
          calls.updates.push({ table, values, filters, returning: columns });
          return Promise.resolve(opts.archived ?? { data: [], error: null });
        },
        then<T>(resolve: (r: QueryResult) => T) {
          calls.updates.push({ table, values, filters });
          return Promise.resolve(opts.update ?? ok).then(resolve);
        },
      };
      return builder;
    },
  }));

  const client = { from } as unknown as Parameters<typeof completeTrip>[0];
  return { client, calls };
}

const NOW = new Date("2026-08-07T19:00:00.000Z");
const now = () => NOW;

const archivedRow = (
  o: Record<string, unknown> & { id: string; name: string },
) => ({ ingredient_id: null, catalog_item_id: null, ...o });

describe("completeTrip", () => {
  it("stamps purchased_at on only this week's checked, un-archived rows", async () => {
    const { client, calls } = makeClient({ archived: { data: [], error: null } });

    await completeTrip(client, { householdId: "hh-1", weekId: "wk-1", now });

    expect(calls.updates).toEqual([
      {
        table: "grocery_items",
        values: { purchased_at: NOW.toISOString() },
        filters: [
          { op: "eq", column: "week_id", value: "wk-1" },
          { op: "eq", column: "checked", value: true },
          { op: "is", column: "purchased_at", value: null },
        ],
        returning: "id, name, ingredient_id, catalog_item_id",
      },
    ]);
  });

  it("counts what was archived and offers ONLY ad-hoc names for promotion", async () => {
    const { client } = makeClient({
      archived: {
        data: [
          archivedRow({ id: "g1", name: "paper towels" }),
          archivedRow({ id: "g2", name: "Flour", ingredient_id: "ing-1" }),
          archivedRow({ id: "g3", name: "Olive oil", catalog_item_id: "c1" }),
          archivedRow({ id: "g4", name: "birthday candles" }),
        ],
        error: null,
      },
    });

    const result = await completeTrip(client, {
      householdId: "hh-1",
      weekId: "wk-1",
      now,
    });

    expect(result).toEqual({
      ok: true,
      archived: 4,
      promotable: ["paper towels", "birthday candles"],
    });
  });

  it("de-duplicates promotion candidates case-insensitively", async () => {
    const { client } = makeClient({
      archived: {
        data: [
          archivedRow({ id: "g1", name: "Paper Towels" }),
          archivedRow({ id: "g2", name: "paper towels" }),
        ],
        error: null,
      },
    });

    const result = await completeTrip(client, {
      householdId: "hh-1",
      weekId: "wk-1",
      now,
    });

    expect(result).toEqual({ ok: true, archived: 2, promotable: ["Paper Towels"] });
  });

  it("reports nothing archived when the cart is empty", async () => {
    const { client } = makeClient({ archived: { data: null, error: null } });

    expect(
      await completeTrip(client, { householdId: "hh-1", weekId: "wk-1", now }),
    ).toEqual({ ok: true, archived: 0, promotable: [] });
  });

  it("returns a generic error when the archive write fails", async () => {
    const { client } = makeClient({
      archived: { data: null, error: { message: "permission denied" } },
    });

    expect(
      await completeTrip(client, { householdId: "hh-1", weekId: "wk-1", now }),
    ).toEqual({ ok: false, error: "Could not complete the trip." });
  });
});

describe("promoteToCatalog", () => {
  it("inserts a new staple for an unknown name, scoped to the caller's household", async () => {
    const { client, calls } = makeClient({ lookups: [{ data: null, error: null }] });

    const result = await promoteToCatalog(client, {
      householdId: "hh-1",
      names: ["paper towels"],
      now,
    });

    expect(result).toEqual({ ok: true, promoted: 1 });
    expect(calls.inserts).toEqual([
      {
        table: "catalog_items",
        rows: {
          household_id: "hh-1",
          name: "paper towels",
          added_count: 1,
          last_added_at: NOW.toISOString(),
        },
      },
    ]);
  });

  it("bumps an existing staple case-insensitively instead of creating a twin", async () => {
    const { client, calls } = makeClient({
      lookups: [{ data: { id: "c1", added_count: 3 }, error: null }],
    });

    const result = await promoteToCatalog(client, {
      householdId: "hh-1",
      names: ["Olive Oil"],
      now,
    });

    expect(result).toEqual({ ok: true, promoted: 1 });
    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toEqual([
      {
        table: "catalog_items",
        values: { added_count: 4, last_added_at: NOW.toISOString() },
        filters: [{ op: "eq", column: "id", value: "c1" }],
      },
    ]);
    // The lookup is household-filtered (defense in depth over RLS).
    expect(calls.selects[0].filters).toEqual([
      { op: "eq", column: "household_id", value: "hh-1" },
      { op: "ilike", column: "name", value: "Olive Oil" },
    ]);
  });

  it("escapes LIKE metacharacters so a typed name can't wildcard-match", async () => {
    const { client, calls } = makeClient({ lookups: [{ data: null, error: null }] });

    await promoteToCatalog(client, {
      householdId: "hh-1",
      names: ["50% cream_soda"],
      now,
    });

    expect(calls.selects[0].filters[1]).toEqual({
      op: "ilike",
      column: "name",
      value: "50\\% cream\\_soda",
    });
    // The STORED name keeps the user's literal text.
    expect((calls.inserts[0].rows as { name: string }).name).toBe("50% cream_soda");
  });

  it("skips blank names and trims the rest", async () => {
    const { client, calls } = makeClient({
      lookups: [{ data: null, error: null }],
    });

    const result = await promoteToCatalog(client, {
      householdId: "hh-1",
      names: ["   ", "  bananas  "],
      now,
    });

    expect(result).toEqual({ ok: true, promoted: 1 });
    expect((calls.inserts[0].rows as { name: string }).name).toBe("bananas");
  });

  it("treats a concurrent duplicate insert as already promoted", async () => {
    const { client } = makeClient({
      lookups: [{ data: null, error: null }],
      insert: { data: null, error: { code: "23505", message: "duplicate key" } },
    });

    expect(
      await promoteToCatalog(client, { householdId: "hh-1", names: ["salt"], now }),
    ).toEqual({ ok: true, promoted: 1 });
  });

  it("returns a generic error when a write is denied", async () => {
    const { client } = makeClient({
      lookups: [{ data: null, error: null }],
      insert: { data: null, error: { code: "42501", message: "permission denied" } },
    });

    expect(
      await promoteToCatalog(client, { householdId: "hh-1", names: ["salt"], now }),
    ).toEqual({ ok: false, error: "Could not add those to your staples." });
  });
});
