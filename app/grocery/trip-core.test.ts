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
 *     also filters the catalog read by it (defense in depth over RLS);
 *   - the catalog is read ONCE per batch and matched in TypeScript, so a name
 *     containing a LIKE/PostgREST metacharacter ("Milk*") can never wildcard-
 *     match a different staple.
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
  /** The single household-scoped catalog read the promotion batch does. */
  catalog?: QueryResult;
  insert?: QueryResult;
  update?: QueryResult;
} = {}) {
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
        then<T>(resolve: (r: QueryResult) => T) {
          calls.selects.push({ table, columns, filters });
          return Promise.resolve(opts.catalog ?? { data: [], error: null }).then(
            resolve,
          );
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
) => ({ ingredient_id: null, catalog_item_id: null, section_id: null, ...o });

describe("completeTrip", () => {
  it("stamps purchased_at on every checked, un-archived row — any week", async () => {
    const { client, calls } = makeClient({ archived: { data: [], error: null } });

    await completeTrip(client, { householdId: "hh-1", weekId: "wk-1", now });

    // Statement ONE of two: the archive. (Statement two clears have-it claims
    // and is pinned by its own test below.)
    expect(calls.updates[0]).toEqual(
      {
        table: "grocery_items",
        values: { purchased_at: NOW.toISOString() },
        filters: [
          // Explicit household fence (defense in depth over RLS), mirroring
          // `promoteToCatalog`.
          { op: "eq", column: "household_id", value: "hh-1" },
          // No week filter: finishing a trip clears everything you ticked off,
          // whenever it was added. A rolling list has no "this week" to scope to.
          { op: "eq", column: "checked", value: true },
          { op: "is", column: "purchased_at", value: null },
        ],
        returning: "id, name, ingredient_id, catalog_item_id, section_id",
      },
    );
  });

  it("clears have-it claims as a SECOND effect — without archiving them (#171)", async () => {
    // A "we have it" claim ends on the next COMPLETED TRIP, never on a calendar
    // boundary: the list is decoupled from time, and a trip happens whenever it
    // happens (ADR 0012). So the item the family used up comes back onto the
    // list instead of being suppressed forever. Crucially this is a SEPARATE
    // statement from the archive: the claimed rows are not stamped
    // `purchased_at`, so they are neither counted as archived nor offered as
    // staples-promotion candidates — nothing was bought.
    const { client, calls } = makeClient({ archived: { data: [], error: null } });

    await completeTrip(client, { householdId: "hh-1", weekId: "wk-1", now });

    expect(calls.updates).toHaveLength(2);
    expect(calls.updates[1]).toEqual({
      table: "grocery_items",
      values: { have_it: false, have_it_at: null },
      filters: [
        { op: "eq", column: "household_id", value: "hh-1" },
        { op: "eq", column: "have_it", value: true },
        // Only STILL-ACTIVE claims: a row archived a moment ago by the
        // statement above is history now and must not be reopened.
        { op: "is", column: "purchased_at", value: null },
      ],
    });
    // No purchase stamp anywhere near it.
    expect(calls.updates[1].values).not.toHaveProperty("purchased_at");
    // And it returns nothing — a cleared claim can never reach `promotable`.
    expect(calls.updates[1].returning).toBeUndefined();
  });

  it("does not count or offer a cleared have-it row (#171)", async () => {
    // The archive `RETURNING` is the ONLY source of both numbers, and it saw
    // only the checked rows.
    const { client } = makeClient({
      archived: {
        data: [archivedRow({ id: "g1", name: "paper towels" })],
        error: null,
      },
    });

    expect(
      await completeTrip(client, { householdId: "hh-1", weekId: "wk-1", now }),
    ).toEqual({
      ok: true,
      archived: 1,
      promotable: [{ name: "paper towels", sectionId: null }],
    });
  });

  it("still reports the completed trip when the claim clear fails (#171)", async () => {
    // The archive has already committed. Reporting failure would tell the
    // shopper the trip did not happen — and a re-tap would archive nothing and
    // lose the promotion prompt. The claims simply clear on the next trip.
    // Same best-effort reasoning as `setItemSection`'s write-through.
    const { client } = makeClient({
      archived: {
        data: [archivedRow({ id: "g1", name: "paper towels" })],
        error: null,
      },
      update: { data: null, error: { message: "permission denied" } },
    });

    expect(
      await completeTrip(client, { householdId: "hh-1", weekId: "wk-1", now }),
    ).toEqual({
      ok: true,
      archived: 1,
      promotable: [{ name: "paper towels", sectionId: null }],
    });
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
      promotable: [
        { name: "paper towels", sectionId: null },
        { name: "birthday candles", sectionId: null },
      ],
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

    expect(result).toEqual({
      ok: true,
      archived: 2,
      promotable: [{ name: "Paper Towels", sectionId: null }],
    });
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

const catalogRows = (rows: { id: string; name: string; added_count: number }[]) => ({
  data: rows,
  error: null,
});

describe("promoteToCatalog", () => {
  it("inserts a new staple for an unknown name, scoped to the caller's household", async () => {
    const { client, calls } = makeClient({
      catalog: catalogRows([{ id: "c1", name: "olive oil", added_count: 3 }]),
    });

    const result = await promoteToCatalog(client, {
      householdId: "hh-1",
      names: ["paper towels"],
      now,
    });

    expect(result).toEqual({ ok: true, promoted: 1, failed: [] });
    expect(calls.inserts).toEqual([
      {
        table: "catalog_items",
        rows: {
          household_id: "hh-1",
          name: "paper towels",
          added_count: 1,
          last_added_at: NOW.toISOString(),
          section_id: null,
        },
      },
    ]);
  });

  it("reads the catalog ONCE per batch, filtered to the caller's household", async () => {
    const { client, calls } = makeClient({ catalog: catalogRows([]) });

    await promoteToCatalog(client, {
      householdId: "hh-1",
      names: ["salt", "pepper", "flour"],
      now,
    });

    // One round trip for the whole batch — no per-name lookup, so no pattern
    // ever reaches the database.
    expect(calls.selects).toEqual([
      {
        table: "catalog_items",
        columns: "id, name, added_count",
        filters: [{ op: "eq", column: "household_id", value: "hh-1" }],
      },
    ]);
  });

  it("bumps an existing staple case-insensitively instead of creating a twin", async () => {
    const { client, calls } = makeClient({
      catalog: catalogRows([{ id: "c1", name: "olive oil", added_count: 3 }]),
    });

    const result = await promoteToCatalog(client, {
      householdId: "hh-1",
      names: ["Olive Oil"],
      now,
    });

    expect(result).toEqual({ ok: true, promoted: 1, failed: [] });
    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toEqual([
      {
        table: "catalog_items",
        values: { added_count: 4, last_added_at: NOW.toISOString() },
        filters: [{ op: "eq", column: "id", value: "c1" }],
      },
    ]);
  });

  it("matches names LITERALLY — a `*` in a typed name can't wildcard-match a staple", async () => {
    // PostgREST aliases `*` to `%` in an ilike pattern (and rewrites `\*` to a
    // literal `\%`, which matches nothing), so the match happens in TypeScript.
    // "Milk*" is its own item; it must not bump "Milk".
    const { client, calls } = makeClient({
      catalog: catalogRows([{ id: "c1", name: "Milk", added_count: 7 }]),
    });

    const result = await promoteToCatalog(client, {
      householdId: "hh-1",
      names: ["Milk*"],
      now,
    });

    expect(result).toEqual({ ok: true, promoted: 1, failed: [] });
    expect(calls.updates).toHaveLength(0);
    expect(calls.inserts).toEqual([
      {
        table: "catalog_items",
        rows: {
          household_id: "hh-1",
          name: "Milk*",
          added_count: 1,
          last_added_at: NOW.toISOString(),
          section_id: null,
        },
      },
    ]);
  });

  it("keeps a `%`/`_` name literal too, storing the user's exact text", async () => {
    const { client, calls } = makeClient({
      catalog: catalogRows([{ id: "c1", name: "50 cream soda", added_count: 1 }]),
    });

    await promoteToCatalog(client, {
      householdId: "hh-1",
      names: ["50% cream_soda"],
      now,
    });

    expect(calls.updates).toHaveLength(0);
    expect((calls.inserts[0].rows as { name: string }).name).toBe("50% cream_soda");
  });

  it("skips blank names and trims the rest", async () => {
    const { client, calls } = makeClient({ catalog: catalogRows([]) });

    const result = await promoteToCatalog(client, {
      householdId: "hh-1",
      names: ["   ", "  bananas  "],
      now,
    });

    expect(result).toEqual({ ok: true, promoted: 1, failed: [] });
    expect((calls.inserts[0].rows as { name: string }).name).toBe("bananas");
  });

  it("returns a plain generic error when the catalog read is denied — nothing written", async () => {
    // Nothing has been written yet, so there is no partial outcome to report:
    // the caller keeps EVERY candidate and a retry is simply the same batch.
    const { client, calls } = makeClient({
      catalog: { data: null, error: { code: "42501", message: "permission denied" } },
    });

    expect(
      await promoteToCatalog(client, { householdId: "hh-1", names: ["salt"], now }),
    ).toEqual({ ok: false, error: "Could not add those to your staples." });
    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  it("treats a concurrent duplicate insert as already promoted", async () => {
    const { client } = makeClient({
      catalog: catalogRows([]),
      insert: { data: null, error: { code: "23505", message: "duplicate key" } },
    });

    // The other phone got there first: the staple exists, which is the outcome
    // the shopper asked for — so it is NOT offered again for a retry.
    expect(
      await promoteToCatalog(client, { householdId: "hh-1", names: ["salt"], now }),
    ).toEqual({ ok: true, promoted: 1, failed: [] });
  });

  it("reports a denied write as FAILED for that name, not as a whole-batch error", async () => {
    const { client } = makeClient({
      catalog: catalogRows([]),
      insert: { data: null, error: { code: "42501", message: "permission denied" } },
    });

    expect(
      await promoteToCatalog(client, { householdId: "hh-1", names: ["salt"], now }),
    ).toEqual({ ok: true, promoted: 0, failed: [{ name: "salt", sectionId: null }] });
  });
});

/**
 * Retry safety (#115). A batch used to stop at the first failed write and
 * report the whole batch as failed — even though the names BEFORE it had
 * already committed. The prompt then kept every name, so a retry promoted the
 * committed ones AGAIN and bumped their `added_count` twice. That count now
 * gates the "Buy again" chips and ranks the Item suggestions, so the inflation
 * is visible.
 *
 * These run against a small STATEFUL fake catalog so the assertion is about
 * the outcome that matters — each staple's final `added_count` — rather than
 * about which statements were issued.
 */
describe("promoteToCatalog — a retry after a partial failure", () => {
  type StoredStaple = { id: string; name: string; added_count: number };

  /**
   * An in-memory `catalog_items` for one household. Any name in `failOnce` has
   * its FIRST write denied (a flaky connection in a store); later writes land.
   */
  function makeCatalogStore(rows: StoredStaple[], failOnce: string[] = []) {
    const table: StoredStaple[] = rows.map((r) => ({ ...r }));
    const pendingFailures = new Set(failOnce.map((n) => n.toLowerCase()));
    const denied: QueryResult = {
      data: null,
      error: { code: "42501", message: "permission denied" },
    };
    const ok: QueryResult = { data: null, error: null };
    let nextId = 1;

    const from = vi.fn(() => ({
      select: () => ({
        eq: () =>
          Promise.resolve({ data: table.map((r) => ({ ...r })), error: null }),
      }),
      insert: (row: { name: string; added_count: number }) => {
        if (pendingFailures.delete(row.name.toLowerCase())) {
          return Promise.resolve(denied);
        }
        table.push({ id: `new-${nextId++}`, name: row.name, added_count: row.added_count });
        return Promise.resolve(ok);
      },
      update: (values: { added_count: number }) => ({
        eq: (_column: string, id: string) => {
          const row = table.find((r) => r.id === id);
          if (!row) return Promise.resolve(ok); // matches nothing, like RLS
          if (pendingFailures.delete(row.name.toLowerCase())) {
            return Promise.resolve(denied);
          }
          row.added_count = values.added_count;
          return Promise.resolve(ok);
        },
      }),
    }));

    const client = { from } as unknown as Parameters<typeof promoteToCatalog>[0];
    /** Every stored staple with this name (case-insensitive) — twins included. */
    const staples = (name: string) =>
      table.filter((r) => r.name.toLowerCase() === name.toLowerCase());
    return { client, staples };
  }

  it("attempts EVERY name and reports only the ones that failed", async () => {
    const { client, staples } = makeCatalogStore(
      [{ id: "c-salt", name: "Salt", added_count: 3 }],
      ["pepper"],
    );

    const result = await promoteToCatalog(client, {
      householdId: "hh-1",
      names: [
        "salt",
        { name: "pepper", sectionId: "sec-spices" },
        { name: "flour", sectionId: "sec-baking" },
      ],
      now,
    });

    // The failure on name 2 did not stop name 3, and a name that WAS written
    // (salt, flour) is never reported as failed. The failed item keeps its
    // aisle, so a retry still files it where the shopper put it.
    expect(result).toEqual({
      ok: true,
      promoted: 2,
      failed: [{ name: "pepper", sectionId: "sec-spices" }],
    });
    expect(staples("salt")).toEqual([{ id: "c-salt", name: "Salt", added_count: 4 }]);
    expect(staples("flour")).toHaveLength(1);
    expect(staples("pepper")).toHaveLength(0);
  });

  it("bumps each staple EXACTLY ONCE across the failed attempt and its retry", async () => {
    const { client, staples } = makeCatalogStore(
      [
        { id: "c-salt", name: "Salt", added_count: 3 },
        { id: "c-pepper", name: "Pepper", added_count: 5 },
      ],
      // Name 2 of 3 fails the first time only.
      ["pepper"],
    );

    const first = await promoteToCatalog(client, {
      householdId: "hh-1",
      names: ["salt", "pepper", "flour"],
      now,
    });
    expect(first).toEqual({
      ok: true,
      promoted: 2,
      failed: [{ name: "pepper", sectionId: null }],
    });

    // The retry is given ONLY what failed — exactly what the prompt keeps.
    const retry = await promoteToCatalog(client, {
      householdId: "hh-1",
      names: first.ok ? first.failed : [],
      now,
    });
    expect(retry).toEqual({ ok: true, promoted: 1, failed: [] });

    // Each staple's total bump across both attempts is 1.
    expect(staples("salt")).toEqual([{ id: "c-salt", name: "Salt", added_count: 4 }]);
    expect(staples("pepper")).toEqual([
      { id: "c-pepper", name: "Pepper", added_count: 6 },
    ]);
    expect(staples("flour")).toEqual([
      expect.objectContaining({ name: "flour", added_count: 1 }),
    ]);
  });
});
