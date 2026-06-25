import { describe, expect, it, vi } from "vitest";

import {
  getOrCreateWeek,
  proposeExistingDish,
  proposeNewDish,
} from "./actions-core";

/**
 * Pure orchestration for the board's data writes (issue #8), tested over an
 * injected Supabase-like client — no live DB. RLS household-scoping is proven by
 * pgTAP (#7); here we pin the application contract:
 *   - lazy week creation is an UPSERT on (household_id, start_date) so reopening
 *     the board never duplicates the week,
 *   - a NEW proposal creates a dish AND a proposal,
 *   - RECYCLE creates only a proposal pointing at the existing dish (no dish
 *     duplication — the dishes table is never touched).
 */

type Result = { data: unknown; error: unknown };

function makeClient(results: Record<string, Result>) {
  const fromTables: string[] = [];
  const dishesInsert: unknown[] = [];
  const proposalsInsert: unknown[] = [];
  const weeksUpsert: { vals: unknown; opts: unknown }[] = [];

  const from = vi.fn((table: string) => {
    fromTables.push(table);
    const terminal = {
      select: () => ({ single: async () => results[table] }),
    };
    return {
      insert: vi.fn((vals: unknown) => {
        if (table === "dishes") dishesInsert.push(vals);
        if (table === "proposals") proposalsInsert.push(vals);
        return terminal;
      }),
      upsert: vi.fn((vals: unknown, opts: unknown) => {
        if (table === "weeks") weeksUpsert.push({ vals, opts });
        return terminal;
      }),
    };
  });

  return {
    client: { from } as unknown as Parameters<typeof getOrCreateWeek>[0],
    calls: { fromTables, dishesInsert, proposalsInsert, weeksUpsert },
  };
}

describe("getOrCreateWeek", () => {
  it("upserts on (household_id, start_date) so reopening does not duplicate", async () => {
    const { client, calls } = makeClient({
      weeks: { data: { id: "w1" }, error: null },
    });

    const result = await getOrCreateWeek(client, {
      householdId: "hh-1",
      startDate: "2026-06-22",
    });

    expect(result).toEqual({ ok: true, weekId: "w1" });
    expect(calls.weeksUpsert).toHaveLength(1);
    expect(calls.weeksUpsert[0].vals).toEqual({
      household_id: "hh-1",
      start_date: "2026-06-22",
    });
    expect(calls.weeksUpsert[0].opts).toMatchObject({
      onConflict: "household_id,start_date",
    });
  });

  it("fails closed when the upsert errors", async () => {
    const { client } = makeClient({
      weeks: { data: null, error: { message: "boom" } },
    });
    const result = await getOrCreateWeek(client, {
      householdId: "hh-1",
      startDate: "2026-06-22",
    });
    expect(result.ok).toBe(false);
  });
});

describe("proposeNewDish", () => {
  it("creates a dish AND a proposal for the week", async () => {
    const { client, calls } = makeClient({
      dishes: { data: { id: "d1" }, error: null },
      proposals: { data: { id: "p1" }, error: null },
    });

    const result = await proposeNewDish(client, {
      householdId: "hh-1",
      weekId: "w1",
      proposedBy: "m1",
      title: "  Carnitas Tacos  ",
      sourceUrl: "  https://example.com/recipe  ",
      note: "  family favorite  ",
    });

    expect(result).toEqual({ ok: true, proposalId: "p1", dishId: "d1" });
    expect(calls.dishesInsert).toEqual([
      {
        household_id: "hh-1",
        title: "Carnitas Tacos",
        source_url: "https://example.com/recipe",
        created_by: "m1",
      },
    ]);
    expect(calls.proposalsInsert).toEqual([
      {
        household_id: "hh-1",
        week_id: "w1",
        dish_id: "d1",
        proposed_by: "m1",
        note: "family favorite",
      },
    ]);
  });

  it("stores null for an omitted recipe URL and note", async () => {
    const { client, calls } = makeClient({
      dishes: { data: { id: "d1" }, error: null },
      proposals: { data: { id: "p1" }, error: null },
    });

    await proposeNewDish(client, {
      householdId: "hh-1",
      weekId: "w1",
      proposedBy: "m1",
      title: "Salad",
      sourceUrl: "",
      note: "",
    });

    expect(calls.dishesInsert[0]).toMatchObject({ source_url: null });
    expect(calls.proposalsInsert[0]).toMatchObject({ note: null });
  });

  it("rejects a blank title before any DB call", async () => {
    const { client, calls } = makeClient({});
    const result = await proposeNewDish(client, {
      householdId: "hh-1",
      weekId: "w1",
      proposedBy: "m1",
      title: "   ",
      sourceUrl: "",
      note: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/title|dish/i);
    expect(calls.fromTables).toEqual([]);
  });

  it("does not create a proposal if the dish insert fails", async () => {
    const { client, calls } = makeClient({
      dishes: { data: null, error: { message: "boom" } },
    });
    const result = await proposeNewDish(client, {
      householdId: "hh-1",
      weekId: "w1",
      proposedBy: "m1",
      title: "Soup",
      sourceUrl: "",
      note: "",
    });
    expect(result.ok).toBe(false);
    expect(calls.proposalsInsert).toEqual([]);
  });
});

describe("proposeExistingDish (recycle / propose again)", () => {
  it("creates only a proposal pointing at the existing dish — no dish duplication", async () => {
    const { client, calls } = makeClient({
      proposals: { data: { id: "p2" }, error: null },
    });

    const result = await proposeExistingDish(client, {
      householdId: "hh-1",
      weekId: "w1",
      proposedBy: "m1",
      dishId: "existing-dish",
      note: "  again please  ",
    });

    expect(result).toEqual({ ok: true, proposalId: "p2" });
    // The dishes table is NEVER touched on a recycle.
    expect(calls.fromTables).not.toContain("dishes");
    expect(calls.dishesInsert).toEqual([]);
    expect(calls.proposalsInsert).toEqual([
      {
        household_id: "hh-1",
        week_id: "w1",
        dish_id: "existing-dish",
        proposed_by: "m1",
        note: "again please",
      },
    ]);
  });

  it("rejects a missing dish id before any DB call", async () => {
    const { client, calls } = makeClient({});
    const result = await proposeExistingDish(client, {
      householdId: "hh-1",
      weekId: "w1",
      proposedBy: "m1",
      dishId: "",
      note: "",
    });
    expect(result.ok).toBe(false);
    expect(calls.fromTables).toEqual([]);
  });
});
