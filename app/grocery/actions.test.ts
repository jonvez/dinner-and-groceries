import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Server Action boundary (issue #15). A Server Action is a PUBLIC endpoint:
 * the form's `maxLength` is a hint to the browser, not a control, so anything a
 * request can oversize has to be bounded here — mirroring the promotion path's
 * `slice(0, MAX_NAME_LENGTH)`.
 *
 * The mutation cores are exhaustively tested in `mutations-core.test.ts`; this
 * file pins only what the action itself does to untrusted `FormData` before the
 * core sees it, plus (issue #210) which analytics events it emits: one
 * `grocery_list_built` per rebuild, one `trip_completed` per finished trip, and
 * — per ADR 0012 — NOTHING for "we have it", which is a pantry fact, not a trip.
 * The actor resolver is mocked (the action must never see an unverified
 * household id); the Supabase client is a recording fake, so the emitted
 * `events` row itself is asserted (no item names, ever).
 */

/** What the action hands the core — the surface these tests assert on. */
type AdHocInput = {
  householdId: string;
  weekId: string;
  name: string;
  quantity: number | null;
  unit: string;
};

type BuildInput = { householdId: string; weekId: string };

const mocks = vi.hoisted(() => {
  const inserts: { table: string; vals: Record<string, unknown> }[] = [];
  const state = { throwOnInsert: false };
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
    actor: { householdId: "hh-1", memberId: "m-1" },
    addAdHocItem: vi.fn<(input: AdHocInput) => Promise<{ ok: true }>>(async () => ({
      ok: true,
    })),
    buildGroceryList: vi.fn<
      (
        input: BuildInput,
      ) => Promise<
        { ok: true; added: number; removed: number } | { ok: false; error: string }
      >
    >(),
    completeTrip: vi.fn<
      (
        input: BuildInput,
      ) => Promise<
        | { ok: true; archived: number; promotable: { name: string }[] }
        | { ok: false; error: string }
      >
    >(),
    setHaveIt: vi.fn<
      () => Promise<{ ok: true } | { ok: false; error: string }>
    >(),
  };
});

vi.mock("@/lib/supabase/server-component", () => ({
  createServerComponentClient: async () => mocks.client as never,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("./actor", () => ({ resolveGroceryActor: async () => mocks.actor }));

vi.mock("./mutations-core", () => ({
  GENERIC_ERROR: "Could not update the list.",
  addAdHocItem: (_client: unknown, input: AdHocInput) => mocks.addAdHocItem(input),
  addCatalogItemToList: vi.fn(),
  setChecked: vi.fn(),
  setHaveIt: () => mocks.setHaveIt(),
  setItemSection: vi.fn(),
}));

vi.mock("./rollup-core", () => ({
  buildGroceryList: (_client: unknown, input: BuildInput) =>
    mocks.buildGroceryList(input),
}));

vi.mock("./trip-core", () => ({
  TRIP_ERROR: "Could not complete the trip.",
  PROMOTE_ERROR: "Could not add those to your staples.",
  completeTrip: (_client: unknown, input: BuildInput) => mocks.completeTrip(input),
  promoteToCatalog: vi.fn(),
}));

const {
  addAdHocItemAction,
  buildGroceryListAction,
  completeTripAction,
  setHaveItAction,
} = await import("./actions");

/** Every `events` row the action caused the real helper to insert. */
function emitted() {
  return mocks.inserts
    .filter((row) => row.table === "events")
    .map((row) => row.vals);
}

beforeEach(() => {
  mocks.inserts.length = 0;
  mocks.state.throwOnInsert = false;
  mocks.buildGroceryList
    .mockReset()
    .mockResolvedValue({ ok: true, added: 7, removed: 2 });
  mocks.completeTrip
    .mockReset()
    .mockResolvedValue({ ok: true, archived: 9, promotable: [] });
  mocks.setHaveIt.mockReset().mockResolvedValue({ ok: true });
});

function formData(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) fd.set(key, value);
  return fd;
}

describe("addAdHocItemAction", () => {
  it("bounds an over-long name and unit server-side (maxLength is not a control)", async () => {
    mocks.addAdHocItem.mockClear();

    await addAdHocItemAction(
      "wk-1",
      null,
      formData({ name: "x".repeat(5_000), unit: "u".repeat(500), quantity: "" }),
    );

    const input = mocks.addAdHocItem.mock.calls[0][0];
    expect(input.name).toHaveLength(200);
    expect(input.unit).toHaveLength(40);
  });

  it("trims BEFORE slicing, so padding can't eat the allowance", async () => {
    mocks.addAdHocItem.mockClear();

    await addAdHocItemAction(
      "wk-1",
      null,
      formData({ name: `   ${"a".repeat(210)}   `, unit: "  packs  ", quantity: "2" }),
    );

    const input = mocks.addAdHocItem.mock.calls[0][0];
    expect(input.name).toBe("a".repeat(200));
    expect(input.unit).toBe("packs");
    expect(input.quantity).toBe(2);
    // The household id comes from the VERIFIED actor, never from the form.
    expect(input.householdId).toBe("hh-1");
    expect(input.weekId).toBe("wk-1");
  });

  it("leaves a normal name untouched", async () => {
    mocks.addAdHocItem.mockClear();

    await addAdHocItemAction("wk-1", null, formData({ name: "paper towels", unit: "" }));

    const input = mocks.addAdHocItem.mock.calls[0][0];
    expect(input.name).toBe("paper towels");
    expect(input.unit).toBe("");
  });

  it("emits no analytics event — an ad-hoc add is not a list build", async () => {
    await addAdHocItemAction("wk-1", null, formData({ name: "eggs", unit: "" }));

    expect(emitted()).toEqual([]);
  });
});

describe("buildGroceryListAction — grocery_list_built", () => {
  it("emits one grocery_list_built with the week and the add/remove counts", async () => {
    const result = await buildGroceryListAction("wk-1");

    expect(result).toEqual({ ok: true, added: 7, removed: 2 });
    expect(emitted()).toEqual([
      {
        household_id: "hh-1",
        member_id: "m-1",
        event_type: "grocery_list_built",
        payload: { weekId: "wk-1", added: 7, removed: 2 },
      },
    ]);
  });

  it("emits nothing when the rebuild fails", async () => {
    mocks.buildGroceryList.mockResolvedValue({ ok: false, error: "nope" });

    await buildGroceryListAction("wk-1");

    expect(emitted()).toEqual([]);
  });

  it("still returns the build result when the analytics insert THROWS", async () => {
    mocks.state.throwOnInsert = true;

    const result = await buildGroceryListAction("wk-1");

    expect(result).toEqual({ ok: true, added: 7, removed: 2 });
  });
});

describe("completeTripAction — trip_completed", () => {
  it("emits one trip_completed with the week and archived count only", async () => {
    mocks.completeTrip.mockResolvedValue({
      ok: true,
      archived: 4,
      promotable: [{ name: "za'atar" }, { name: "oat milk" }],
    });

    const result = await completeTripAction("wk-1");

    expect(result.ok).toBe(true);
    expect(emitted()).toEqual([
      {
        household_id: "hh-1",
        member_id: "m-1",
        event_type: "trip_completed",
        payload: { weekId: "wk-1", archived: 4 },
      },
    ]);
    // Grocery item names are the shopper's own words — never in an event.
    const payload = JSON.stringify(emitted()[0].payload);
    expect(payload).not.toContain("za'atar");
    expect(payload).not.toContain("oat milk");
  });

  it("emits nothing when the trip fails", async () => {
    mocks.completeTrip.mockResolvedValue({ ok: false, error: "nope" });

    await completeTripAction("wk-1");

    expect(emitted()).toEqual([]);
  });

  it("still returns the trip result when the analytics insert THROWS", async () => {
    mocks.state.throwOnInsert = true;

    const result = await completeTripAction("wk-1");

    expect(result.ok).toBe(true);
  });
});

describe('setHaveItAction — "we have it" is not a trip (ADR 0012)', () => {
  it("emits NO trip_completed (nor any other event)", async () => {
    const result = await setHaveItAction("item-1", true);

    expect(result).toEqual({ ok: true });
    expect(emitted()).toEqual([]);
  });
});
