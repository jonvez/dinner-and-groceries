import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Analytics emission at the propose Server Actions (issue #210). The write
 * cores are exhaustively covered by `actions-core.test.ts`; this file pins ONLY
 * what the action emits:
 *   - exactly one `proposal_created` row per successful propose (both the
 *     brand-new and the recycle path), attributed to the VERIFIED actor's
 *     household + pseudonymous member id,
 *   - nothing at all when the write fails or the caller can't be resolved,
 *   - no free text the user typed (title / note) in the payload,
 *   - and a broken analytics transport never turns a successful propose into an
 *     error (the helper fails closed).
 *
 * `emitEvent` is deliberately NOT mocked: the assertions run over the row the
 * real helper hands the injected fake client, so the PII boundary is asserted
 * on the actual `events` insert.
 */

type ProposeNewInput = {
  householdId: string;
  weekId: string;
  proposedBy: string;
  title: string;
  sourceUrl: string;
  note: string;
};

type ProposeExistingInput = {
  householdId: string;
  weekId: string;
  proposedBy: string;
  dishId: string;
  note: string;
};

type CoreResult =
  | { ok: true; proposalId: string; dishId?: string }
  | { ok: false; error: string };

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
    proposeNewDish: vi.fn<(input: ProposeNewInput) => Promise<CoreResult>>(),
    proposeExistingDish:
      vi.fn<(input: ProposeExistingInput) => Promise<CoreResult>>(),
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

vi.mock("./actions-core", () => ({
  proposeNewDish: (_client: unknown, input: ProposeNewInput) =>
    mocks.proposeNewDish(input),
  proposeExistingDish: (_client: unknown, input: ProposeExistingInput) =>
    mocks.proposeExistingDish(input),
}));

const { proposeNewDishAction, recycleDishAction } = await import("./actions");

function formData(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) fd.set(key, value);
  return fd;
}

/** Every `events` row the action caused the helper to insert. */
function emitted() {
  return mocks.inserts
    .filter((row) => row.table === "events")
    .map((row) => row.vals);
}

beforeEach(() => {
  mocks.inserts.length = 0;
  mocks.state.actor = { householdId: "hh-1", memberId: "m-1", weekStartDay: 1 };
  mocks.state.week = { weekId: "wk-1" };
  mocks.state.throwOnInsert = false;
  mocks.proposeNewDish.mockReset().mockResolvedValue({
    ok: true,
    proposalId: "p-1",
    dishId: "d-1",
  });
  mocks.proposeExistingDish.mockReset().mockResolvedValue({
    ok: true,
    proposalId: "p-2",
  });
});

describe("proposeNewDishAction — proposal_created", () => {
  it("emits exactly one proposal_created attributed to the verified member", async () => {
    const result = await proposeNewDishAction(
      null,
      formData({ weekStart: "2026-09-14", title: "Carnitas", note: "kid pick" }),
    );

    expect(result).toEqual({ added: true });
    expect(emitted()).toEqual([
      {
        household_id: "hh-1",
        member_id: "m-1",
        event_type: "proposal_created",
        payload: { proposalId: "p-1", dishId: "d-1", weekId: "wk-1" },
      },
    ]);
  });

  it("keeps the user's typed title and note OUT of the payload", async () => {
    await proposeNewDishAction(
      null,
      formData({
        weekStart: "2026-09-14",
        title: "Grandma's Lasagna",
        note: "because Ana asked for it",
      }),
    );

    const payload = JSON.stringify(emitted()[0].payload);
    expect(payload).not.toContain("Lasagna");
    expect(payload).not.toContain("Ana");
    expect(Object.keys(emitted()[0].payload as object).sort()).toEqual([
      "dishId",
      "proposalId",
      "weekId",
    ]);
  });

  it("emits nothing when the write fails", async () => {
    mocks.proposeNewDish.mockResolvedValue({ ok: false, error: "nope" });

    const result = await proposeNewDishAction(
      null,
      formData({ weekStart: "2026-09-14", title: "Carnitas" }),
    );

    expect(result).toEqual({ error: "nope" });
    expect(emitted()).toEqual([]);
  });

  it("emits nothing when the caller can't be resolved", async () => {
    mocks.state.actor = null;

    await proposeNewDishAction(null, formData({ title: "Carnitas" }));

    expect(emitted()).toEqual([]);
    expect(mocks.proposeNewDish).not.toHaveBeenCalled();
  });

  it("still succeeds when the analytics insert THROWS", async () => {
    mocks.state.throwOnInsert = true;

    const result = await proposeNewDishAction(
      null,
      formData({ weekStart: "2026-09-14", title: "Carnitas" }),
    );

    expect(result).toEqual({ added: true });
  });
});

describe("recycleDishAction — proposal_created", () => {
  it("emits one proposal_created carrying the recycled dish id", async () => {
    const result = await recycleDishAction(
      null,
      formData({ weekStart: "2026-09-14", dishId: "d-9", note: "again please" }),
    );

    expect(result).toEqual({ added: true });
    expect(emitted()).toEqual([
      {
        household_id: "hh-1",
        member_id: "m-1",
        event_type: "proposal_created",
        payload: { proposalId: "p-2", dishId: "d-9", weekId: "wk-1" },
      },
    ]);
  });

  it("emits nothing when the recycle write fails", async () => {
    mocks.proposeExistingDish.mockResolvedValue({ ok: false, error: "nope" });

    await recycleDishAction(null, formData({ weekStart: "2026-09-14", dishId: "d-9" }));

    expect(emitted()).toEqual([]);
  });
});
