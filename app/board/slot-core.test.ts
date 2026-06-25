import { describe, expect, it, vi } from "vitest";

import { getOrCreateSlot, slotDish, unslotDish } from "./slot-core";

/**
 * Pure orchestration for tap-to-slot / tap-to-unslot (issue #10), tested over an
 * injected Supabase-like client — no live DB. RLS household-scoping is proven by
 * pgTAP (#7); here we pin the application contract:
 *   - find-or-create-slot is an IDEMPOTENT UPSERT on (week_id, day_of_week,
 *     meal_type) so concurrent taps / re-renders converge on ONE slot (never a
 *     duplicate). [NB: this requires a UNIQUE constraint on those columns — see
 *     the PR description; the action fails loudly rather than silently duping.]
 *   - a slot holds MANY dishes: slotting inserts a slot_dishes row; the same dish
 *     can be slotted twice in a week (duplicate slotting allowed — ADR 0003).
 *   - untrusted targets (meal_type / day_of_week) are validated server-side
 *     BEFORE any write.
 *   - unslot removes exactly the one slot_dishes row (reversible).
 */

type Result = { data: unknown; error: unknown };

function makeClient(results: Record<string, Result>) {
  const fromTables: string[] = [];
  const slotsUpsert: { vals: unknown; opts: unknown }[] = [];
  const slotDishesInsert: unknown[] = [];
  const slotDishesDelete: { col: string; val: unknown }[] = [];

  const from = vi.fn((table: string) => {
    fromTables.push(table);
    const terminal = {
      select: () => ({ single: async () => results[table] }),
    };
    return {
      upsert: vi.fn((vals: unknown, opts: unknown) => {
        if (table === "slots") slotsUpsert.push({ vals, opts });
        return terminal;
      }),
      insert: vi.fn((vals: unknown) => {
        if (table === "slot_dishes") slotDishesInsert.push(vals);
        return terminal;
      }),
      delete: vi.fn(() => ({
        eq: vi.fn(async (col: string, val: unknown) => {
          if (table === "slot_dishes") slotDishesDelete.push({ col, val });
          return results[`${table}:delete`] ?? { data: null, error: null };
        }),
      })),
    };
  });

  return {
    client: { from } as unknown as Parameters<typeof getOrCreateSlot>[0],
    calls: { fromTables, slotsUpsert, slotDishesInsert, slotDishesDelete },
  };
}

describe("getOrCreateSlot", () => {
  it("upserts on (week_id, day_of_week, meal_type) so taps converge on one slot", async () => {
    const { client, calls } = makeClient({
      slots: { data: { id: "s1" }, error: null },
    });

    const result = await getOrCreateSlot(client, {
      householdId: "hh-1",
      weekId: "w1",
      dayOfWeek: 2,
      mealType: "dinner",
    });

    expect(result).toEqual({ ok: true, slotId: "s1" });
    expect(calls.slotsUpsert).toHaveLength(1);
    expect(calls.slotsUpsert[0].vals).toEqual({
      household_id: "hh-1",
      week_id: "w1",
      day_of_week: 2,
      meal_type: "dinner",
    });
    expect(calls.slotsUpsert[0].opts).toMatchObject({
      onConflict: "week_id,day_of_week,meal_type",
    });
  });

  it("rejects an off-enum meal_type before any DB call (untrusted target)", async () => {
    const { client, calls } = makeClient({});
    const result = await getOrCreateSlot(client, {
      householdId: "hh-1",
      weekId: "w1",
      dayOfWeek: 2,
      mealType: "brunch",
    });
    expect(result.ok).toBe(false);
    expect(calls.fromTables).toEqual([]);
  });

  it("rejects an out-of-range day_of_week before any DB call", async () => {
    const { client, calls } = makeClient({});
    const result = await getOrCreateSlot(client, {
      householdId: "hh-1",
      weekId: "w1",
      dayOfWeek: 9,
      mealType: "dinner",
    });
    expect(result.ok).toBe(false);
    expect(calls.fromTables).toEqual([]);
  });

  it("fails closed when the upsert errors", async () => {
    const { client } = makeClient({
      slots: { data: null, error: { message: "boom" } },
    });
    const result = await getOrCreateSlot(client, {
      householdId: "hh-1",
      weekId: "w1",
      dayOfWeek: 2,
      mealType: "dinner",
    });
    expect(result.ok).toBe(false);
  });
});

describe("slotDish", () => {
  it("finds-or-creates the slot then inserts a slot_dishes row", async () => {
    const { client, calls } = makeClient({
      slots: { data: { id: "s1" }, error: null },
      slot_dishes: { data: { id: "sd1" }, error: null },
    });

    const result = await slotDish(client, {
      householdId: "hh-1",
      weekId: "w1",
      dishId: "d1",
      dayOfWeek: 2,
      mealType: "dinner",
    });

    expect(result).toEqual({ ok: true, slotId: "s1", slotDishId: "sd1" });
    expect(calls.slotDishesInsert).toEqual([
      { household_id: "hh-1", slot_id: "s1", dish_id: "d1" },
    ]);
  });

  it("allows the SAME dish to be slotted twice (duplicate slotting — ADR 0003)", async () => {
    const { client, calls } = makeClient({
      slots: { data: { id: "s1" }, error: null },
      slot_dishes: { data: { id: "sd1" }, error: null },
    });

    await slotDish(client, {
      householdId: "hh-1",
      weekId: "w1",
      dishId: "d1",
      dayOfWeek: 2,
      mealType: "dinner",
    });
    await slotDish(client, {
      householdId: "hh-1",
      weekId: "w1",
      dishId: "d1",
      dayOfWeek: 2,
      mealType: "dinner",
    });

    // Two inserts, no dedupe / conflict handling — it rolls up twice later.
    expect(calls.slotDishesInsert).toHaveLength(2);
  });

  it("rejects a blank dish id before any DB call", async () => {
    const { client, calls } = makeClient({});
    const result = await slotDish(client, {
      householdId: "hh-1",
      weekId: "w1",
      dishId: "   ",
      dayOfWeek: 2,
      mealType: "dinner",
    });
    expect(result.ok).toBe(false);
    expect(calls.fromTables).toEqual([]);
  });

  it("does not insert a slot_dishes row if the slot upsert fails", async () => {
    const { client, calls } = makeClient({
      slots: { data: null, error: { message: "boom" } },
    });
    const result = await slotDish(client, {
      householdId: "hh-1",
      weekId: "w1",
      dishId: "d1",
      dayOfWeek: 2,
      mealType: "dinner",
    });
    expect(result.ok).toBe(false);
    expect(calls.slotDishesInsert).toEqual([]);
  });
});

describe("unslotDish (reversible)", () => {
  it("deletes exactly the one slot_dishes row by id", async () => {
    const { client, calls } = makeClient({});
    const result = await unslotDish(client, { slotDishId: "sd1" });
    expect(result).toEqual({ ok: true, removed: true });
    expect(calls.slotDishesDelete).toEqual([{ col: "id", val: "sd1" }]);
  });

  it("rejects a blank slot_dishes id before any DB call", async () => {
    const { client, calls } = makeClient({});
    const result = await unslotDish(client, { slotDishId: "" });
    expect(result.ok).toBe(false);
    expect(calls.fromTables).toEqual([]);
  });

  it("fails closed when the delete errors", async () => {
    const { client } = makeClient({
      "slot_dishes:delete": { data: null, error: { message: "boom" } },
    });
    const result = await unslotDish(client, { slotDishId: "sd1" });
    expect(result.ok).toBe(false);
  });
});
