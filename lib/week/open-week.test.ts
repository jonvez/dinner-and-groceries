import { describe, expect, it, vi } from "vitest";

import { getOrCreateWeek, loadWeekSettings } from "./open-week";

/**
 * The shared "which week am I looking at, and does its row exist yet?" helper —
 * used by BOTH the board (`app/board`) and the shopping list (`app/grocery`), so
 * the two screens can never drift onto different weeks (issue #15). Tested over
 * an injected Supabase-like client — no live DB. RLS household-scoping is proven
 * by pgTAP (#7).
 */

type Result = { data: unknown; error: unknown };

function makeClient(results: Record<string, Result>) {
  const weeksUpsert: { vals: unknown; opts: unknown }[] = [];
  const selects: { table: string; columns: string }[] = [];

  const from = vi.fn((table: string) => ({
    upsert: vi.fn((vals: unknown, opts: unknown) => {
      if (table === "weeks") weeksUpsert.push({ vals, opts });
      return { select: () => ({ single: async () => results[table] }) };
    }),
    select: vi.fn((columns: string) => {
      selects.push({ table, columns });
      return { maybeSingle: async () => results[table] };
    }),
  }));

  return {
    client: { from } as unknown as Parameters<typeof getOrCreateWeek>[0],
    calls: { weeksUpsert, selects },
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

describe("loadWeekSettings", () => {
  it("reads the household's timezone + week-start day (RLS-scoped, no filter)", async () => {
    const { client, calls } = makeClient({
      households: {
        data: { timezone: "America/Chicago", week_start_day: 0 },
        error: null,
      },
    });

    expect(await loadWeekSettings(client)).toEqual({
      timezone: "America/Chicago",
      weekStartDay: 0,
    });
    expect(calls.selects).toEqual([
      { table: "households", columns: "timezone, week_start_day" },
    ]);
  });

  it("falls back to the documented defaults when the row is missing", async () => {
    const { client } = makeClient({ households: { data: null, error: null } });

    expect(await loadWeekSettings(client)).toEqual({
      timezone: "America/Los_Angeles",
      weekStartDay: 1,
    });
  });
});
