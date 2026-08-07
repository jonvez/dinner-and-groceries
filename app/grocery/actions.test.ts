import { describe, expect, it, vi } from "vitest";

/**
 * The Server Action boundary (issue #15). A Server Action is a PUBLIC endpoint:
 * the form's `maxLength` is a hint to the browser, not a control, so anything a
 * request can oversize has to be bounded here — mirroring the promotion path's
 * `slice(0, MAX_NAME_LENGTH)`.
 *
 * The mutation cores are exhaustively tested in `mutations-core.test.ts`; this
 * file pins only what the action itself does to untrusted `FormData` before the
 * core sees it. The Supabase client and the actor resolver are mocked — the
 * action must never see an unverified household id.
 */

/** What the action hands the core — the surface these tests assert on. */
type AdHocInput = {
  householdId: string;
  weekId: string;
  name: string;
  quantity: number | null;
  unit: string;
};

const mocks = vi.hoisted(() => ({
  actor: { householdId: "hh-1", memberId: "m-1" },
  addAdHocItem: vi.fn<(input: AdHocInput) => Promise<{ ok: true }>>(async () => ({
    ok: true,
  })),
}));

vi.mock("@/lib/supabase/server-component", () => ({
  createServerComponentClient: async () => ({}) as never,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("./actor", () => ({ resolveGroceryActor: async () => mocks.actor }));

vi.mock("./mutations-core", () => ({
  GENERIC_ERROR: "Could not update the list.",
  addAdHocItem: (_client: unknown, input: AdHocInput) => mocks.addAdHocItem(input),
  addCatalogItemToList: vi.fn(),
  setChecked: vi.fn(),
  setHaveIt: vi.fn(),
}));

const { addAdHocItemAction } = await import("./actions");

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
});
