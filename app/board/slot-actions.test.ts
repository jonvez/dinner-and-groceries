import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Analytics emission at the slot Server Actions (issue #210). `slot-core` owns
 * the write semantics (`slot-core.test.ts`); this file pins ONLY what the
 * actions emit:
 *   - one `slot_filled` per successful slot, carrying the slot + dish ids and
 *     the (validated) day/meal coordinates — the agreed-menu signal the
 *     dashboard counts,
 *   - NOTHING when a dish is unslotted (there is no `slot_emptied` type),
 *   - nothing on a rejected/failed slot,
 *   - and a broken analytics transport never fails the slot.
 */

type SlotInput = {
  householdId: string;
  weekId: string;
  dishId: string;
  dayOfWeek: number;
  mealType: string;
};

const mocks = vi.hoisted(() => {
  const inserts: { table: string; vals: Record<string, unknown> }[] = [];
  const state = {
    actor: { householdId: "hh-1", memberId: "m-1", weekStartDay: 1 } as
      | { householdId: string; memberId: string; weekStartDay: number }
      | null,
    week: { weekId: "wk-1" } as { weekId: string } | { error: string },
    throwOnInsert: false,
  };
  const client = {
    from: (table: string) => ({
      insert: (vals: Record<string, unknown>) => {
        if (state.throwOnInsert) throw new Error("analytics transport down");
        inserts.push({ table, vals });
        return Promise.resolve({ error: null });
      },
    }),
  };

  return {
    inserts,
    state,
    client,
    slotDish: vi.fn<
      (
        input: SlotInput,
      ) => Promise<
        | { ok: true; slotId: string; slotDishId: string }
        | { ok: false; error: string }
      >
    >(),
    unslotDish: vi.fn<
      () => Promise<{ ok: true; removed: true } | { ok: false; error: string }>
    >(),
  };
});

vi.mock("@/lib/supabase/server-component", () => ({
  createServerComponentClient: async () => mocks.client as never,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("./actor", () => ({
  GENERIC_ERROR: "Something went wrong. Reload and try again.",
  resolveActor: async () => mocks.state.actor,
  resolveWeekId: async () => mocks.state.week,
}));

vi.mock("./slot-core", () => ({
  slotDish: (_client: unknown, input: SlotInput) => mocks.slotDish(input),
  unslotDish: () => mocks.unslotDish(),
}));

const { slotDishAction, unslotDishAction } = await import("./slot-actions");

function formData(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) fd.set(key, value);
  return fd;
}

function emitted() {
  return mocks.inserts
    .filter((row) => row.table === "events")
    .map((row) => row.vals);
}

const SLOT_FORM = {
  weekStart: "2026-09-14",
  dishId: "d-1",
  dayOfWeek: "3",
  mealType: "dinner",
};

beforeEach(() => {
  mocks.inserts.length = 0;
  mocks.state.actor = { householdId: "hh-1", memberId: "m-1", weekStartDay: 1 };
  mocks.state.week = { weekId: "wk-1" };
  mocks.state.throwOnInsert = false;
  mocks.slotDish
    .mockReset()
    .mockResolvedValue({ ok: true, slotId: "s-1", slotDishId: "sd-1" });
  mocks.unslotDish.mockReset().mockResolvedValue({ ok: true, removed: true });
});

describe("slotDishAction — slot_filled", () => {
  it("emits exactly one slot_filled attributed to the verified member", async () => {
    const result = await slotDishAction(null, formData(SLOT_FORM));

    expect(result).toEqual({ slotted: true });
    expect(emitted()).toEqual([
      {
        household_id: "hh-1",
        member_id: "m-1",
        event_type: "slot_filled",
        payload: {
          slotDishId: "sd-1",
          dishId: "d-1",
          dayOfWeek: 3,
          mealType: "dinner",
        },
      },
    ]);
  });

  it("emits nothing when the slot write fails", async () => {
    mocks.slotDish.mockResolvedValue({ ok: false, error: "nope" });

    await slotDishAction(null, formData(SLOT_FORM));

    expect(emitted()).toEqual([]);
  });

  it("emits nothing for an off-grid day / unknown meal (rejected up front)", async () => {
    await slotDishAction(
      null,
      formData({ ...SLOT_FORM, dayOfWeek: "99", mealType: "brunch" }),
    );

    expect(emitted()).toEqual([]);
    expect(mocks.slotDish).not.toHaveBeenCalled();
  });

  it("still succeeds when the analytics insert THROWS", async () => {
    mocks.state.throwOnInsert = true;

    const result = await slotDishAction(null, formData(SLOT_FORM));

    expect(result).toEqual({ slotted: true });
  });
});

describe("unslotDishAction", () => {
  it("emits NOTHING — an emptied slot is not a participation event", async () => {
    const result = await unslotDishAction(null, formData({ slotDishId: "sd-1" }));

    expect(result).toEqual({ unslotted: true });
    expect(emitted()).toEqual([]);
  });
});
