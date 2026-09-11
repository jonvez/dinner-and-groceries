import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GroceryList, formatAmount, toChange } from "./grocery-list";
import type { CatalogRow, GroceryRow } from "./list-core";
import type { SectionRow } from "./sections-core";

/**
 * The live shopping list (issue #15). The data cores are exhaustively tested in
 * `list-core` / `mutations-core` / `trip-core`; here we pin the COMPONENT
 * wiring, mirroring `app/board/proposal-pool.test.tsx`:
 *   - the Realtime socket is authenticated as the user BEFORE the channel joins,
 *     and the channel is household-scoped (`filter: household_id=eq.<id>`);
 *   - incoming changes merge by PK, are scoped to this week, and an ARCHIVED row
 *     (purchased_at set) or a CLAIMED one (have_it_at set) leaves the active
 *     list — that's how the other phone sees "complete trip" and "we have it";
 *   - a missing quantity/unit renders as NOTHING (never "0"/"1");
 *   - "we have it" removes the row in ONE tap, optimistically, with an Undo
 *     that puts it back intact (#171);
 *   - checking a box calls the check-off action optimistically.
 *
 * Genuine two-client delivery over a real socket is covered by
 * `e2e/authed/grocery-checkoff.spec.ts`.
 */

const rt = vi.hoisted(() => ({
  handler: undefined as undefined | ((p: unknown) => void),
  filter: "",
  channelName: "",
  subscribeCb: undefined as undefined | ((s: string) => void),
  removeChannel: vi.fn(),
  setAuthTokens: [] as string[],
  events: [] as string[],
  refresh: vi.fn(),
}));

// The reconnect snapshot comes from a SERVER re-render: the browser client has
// no session (auth cookies are httpOnly), so a browser-client read would run as
// anon, be denied by RLS, and blank the list.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: rt.refresh }) }));

vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => {
    const channel = (name: string) => {
      rt.channelName = name;
      const chain: Record<string, unknown> = {
        on: (
          _e: string,
          opts: { table: string; filter: string },
          handler: (p: unknown) => void,
        ) => {
          rt.handler = handler;
          rt.filter = opts.filter;
          return chain;
        },
        subscribe: (cb: (s: string) => void) => {
          rt.events.push("subscribe");
          rt.subscribeCb = cb;
          cb("SUBSCRIBED");
          return chain;
        },
      };
      return chain;
    };
    const realtime = {
      setAuth: async (token: string) => {
        rt.events.push("setAuth");
        rt.setAuthTokens.push(token);
      },
    };
    // The browser client is used ONLY for the socket — it has no session, so it
    // must never be used for a data read (see the reconnect test).
    const from = () => {
      throw new Error("the browser client must not read data (no session)");
    };
    return { channel, from, removeChannel: rt.removeChannel, realtime };
  },
}));

type ToggleFn = (
  id: string,
  value: boolean,
) => Promise<{ ok: true } | { error: string }>;

const actions = vi.hoisted(() => ({
  setChecked: vi.fn<ToggleFn>(async () => ({ ok: true })),
  setHaveIt: vi.fn<ToggleFn>(async () => ({ ok: true })),
  setItemSection: vi.fn<
    (id: string, sectionId: string | null) => Promise<{ ok: true } | { error: string }>
  >(async () => ({ ok: true })),
}));

vi.mock("./actions", () => ({
  addAdHocItemAction: async () => null,
  addCatalogItemToListAction: async () => ({ ok: true }),
  buildGroceryListAction: async () => ({ ok: true, added: 0, removed: 0 }),
  completeTripAction: async () => ({ ok: true, archived: 0, promotable: [] }),
  promoteToCatalogAction: async () => ({ ok: true, promoted: 0 }),
  setCheckedAction: (id: string, checked: boolean) => actions.setChecked(id, checked),
  setHaveItAction: (id: string, haveIt: boolean) => actions.setHaveIt(id, haveIt),
  setItemSectionAction: (id: string, sectionId: string | null) =>
    actions.setItemSection(id, sectionId),
}));

beforeEach(() => {
  rt.handler = undefined;
  rt.filter = "";
  rt.channelName = "";
  rt.subscribeCb = undefined;
  rt.removeChannel.mockClear();
  rt.setAuthTokens = [];
  rt.events = [];
  rt.refresh.mockClear();
  actions.setChecked.mockClear();
  actions.setHaveIt.mockClear();
  actions.setHaveIt.mockImplementation(async () => ({ ok: true }));
  actions.setItemSection.mockClear();
  actions.setItemSection.mockImplementation(async () => ({ ok: true }));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "user-jwt", expiresAt: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function connected() {
  await waitFor(() => expect(rt.subscribeCb).toBeDefined());
}

const row = (o: Partial<GroceryRow> & { id: string; name: string }): GroceryRow => ({
  quantity: null,
  unit: null,
  ingredientId: null,
  catalogItemId: null,
  sectionId: null,
  haveIt: false,
  checked: false,
  edited: false,
  position: 0,
  createdAt: "2026-08-07T00:00:00.000Z",
  ...o,
});

/**
 * A small staples catalog. `addedCount` matters now: the chip row only renders
 * staples bought CHIP_MIN_ADDED_COUNT+ times, and autocomplete ranks by it.
 */
const CATALOG: CatalogRow[] = [
  { id: "c1", name: "Olive oil", defaultUnit: null, addedCount: 0 },
];

const SECTIONS: SectionRow[] = [
  { id: "s-produce", name: "Produce", position: 10 },
  { id: "s-dairy", name: "Dairy & Eggs", position: 30 },
  { id: "s-unsorted", name: "Unsorted", position: 110 },
];

function renderList(items: GroceryRow[], sections: SectionRow[] = SECTIONS) {
  const props = (next: GroceryRow[]) => (
    <GroceryList
      weekId="wk-1"
      householdId="hh-1"
      initialItems={next}
      catalog={CATALOG}
      sections={sections}
    />
  );
  const view = render(props(items));
  /** Push a fresh SERVER snapshot, as a `revalidatePath` round trip does. */
  return { ...view, snapshot: (next: GroceryRow[]) => view.rerender(props(next)) };
}

const changePayload = (
  eventType: "INSERT" | "UPDATE" | "DELETE",
  newRow: Record<string, unknown>,
  oldRow: Record<string, unknown> = {},
) => ({ eventType, new: newRow, old: oldRow });

const dbRow = (o: Record<string, unknown> & { id: string; name: string }) => ({
  week_id: "wk-1",
  quantity: null,
  unit: null,
  ingredient_id: null,
  catalog_item_id: null,
  have_it: false,
  checked: false,
  edited: false,
  position: 0,
  created_at: "2026-08-07T00:00:00.000Z",
  purchased_at: null,
  /** #171: set ⇒ the family has it, so the row is off the shopping list. */
  have_it_at: null,
  section_id: null,
  ...o,
});

describe("formatAmount", () => {
  it("renders a missing quantity/unit as nothing — never 0 or 1", () => {
    expect(formatAmount(null, null)).toBe("");
    expect(formatAmount(null, "cup")).toBe("cup");
    expect(formatAmount(2, null)).toBe("2");
    expect(formatAmount(2, "cup")).toBe("2 cup");
  });
});

describe("toChange", () => {
  it("keeps a row from another week — the list is rolling, not week-scoped", () => {
    // Dropping these is what would have made a carried-over item's live
    // check-off invisible on the other phone until a reload.
    expect(
      toChange(changePayload("INSERT", dbRow({ id: "g1", name: "x", week_id: "wk-2" }))),
    ).toEqual({ type: "INSERT", row: expect.objectContaining({ id: "g1", name: "x" }) });
  });

  it("treats an archived row as a removal from the active list", () => {
    expect(
      toChange(
        changePayload("UPDATE", dbRow({ id: "g1", name: "x", purchased_at: "2026-08-07T19:00:00Z" })),
      ),
    ).toEqual({ type: "DELETE", id: "g1" });
  });

  it("treats a claimed have-it row as a removal from the active list (#171)", () => {
    // This is how the OTHER phone drops the item live: the row is still in
    // `grocery_items` (the planner needs it) but it is off the shopping list.
    expect(
      toChange(
        changePayload(
          "UPDATE",
          dbRow({
            id: "g1",
            name: "olive oil",
            have_it: true,
            have_it_at: "2026-09-07T18:00:00Z",
          }),
        ),
      ),
    ).toEqual({ type: "DELETE", id: "g1" });
  });

  it("brings a row back when the other phone undoes the claim (#171)", () => {
    // `mergeChange` upserts by PK, so an UPDATE for a row this phone already
    // dropped fills the missing INSERT — the undo propagates without a reload.
    expect(
      toChange(changePayload("UPDATE", dbRow({ id: "g1", name: "olive oil" }))),
    ).toEqual({ type: "UPDATE", row: expect.objectContaining({ id: "g1" }) });
  });

  it("maps a DELETE by primary key", () => {
    expect(toChange(changePayload("DELETE", {}, { id: "g1" }))).toEqual({
      type: "DELETE",
      id: "g1",
    });
  });
});

describe("GroceryList", () => {
  it("authenticates the socket BEFORE joining a household-scoped channel", async () => {
    renderList([]);
    await connected();

    expect(rt.events).toEqual(["setAuth", "subscribe"]);
    expect(rt.setAuthTokens).toEqual(["user-jwt"]);
    expect(rt.channelName).toBe("grocery-list:hh-1");
    expect(rt.filter).toBe("household_id=eq.hh-1");
    await waitFor(() => expect(screen.getByTestId("realtime-status")).toHaveTextContent("Live"));
  });

  it("renders an unquantified item as just its name", async () => {
    renderList([row({ id: "g1", name: "eggs" })]);
    await connected();

    const item = screen.getByTestId("grocery-item");
    expect(within(item).getByText("eggs")).toBeInTheDocument();
    expect(item).not.toHaveTextContent("0");
    expect(item).not.toHaveTextContent("1");
  });

  it("marks a dish-derived row as coming from the menu", async () => {
    renderList([row({ id: "g1", name: "Flour", quantity: 2, unit: "cup", ingredientId: "ing-1" })]);
    await connected();

    const item = screen.getByTestId("grocery-item");
    expect(within(item).getByText("2 cup")).toBeInTheDocument();
    expect(within(item).getByText("from the menu")).toBeInTheDocument();
  });

  it("checks an item off through the action", async () => {
    renderList([row({ id: "g1", name: "eggs" })]);
    await connected();

    const box = screen.getByRole("checkbox", { name: "eggs" });
    await act(async () => {
      box.click();
    });

    expect(actions.setChecked).toHaveBeenCalledWith("g1", true);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "eggs" })).toBeChecked());
  });

  it("merges the other shopper's check-off live, by PK", async () => {
    renderList([row({ id: "g1", name: "eggs" })]);
    await connected();

    await act(async () => {
      rt.handler?.(changePayload("UPDATE", dbRow({ id: "g1", name: "eggs", checked: true })));
    });

    expect(screen.getAllByTestId("grocery-item")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: "eggs" })).toBeChecked();
  });

  it("removes a row that arrives archived (the other phone completed the trip)", async () => {
    renderList([row({ id: "g1", name: "eggs" })]);
    await connected();

    await act(async () => {
      rt.handler?.(
        changePayload(
          "UPDATE",
          dbRow({ id: "g1", name: "eggs", checked: true, purchased_at: "2026-08-07T19:00:00Z" }),
        ),
      );
    });

    expect(screen.queryByTestId("grocery-item")).not.toBeInTheDocument();
  });

  it("asks the SERVER for the authoritative snapshot after a reconnect", async () => {
    renderList([row({ id: "g1", name: "eggs" })]);
    await connected();
    expect(rt.refresh).not.toHaveBeenCalled();

    await act(async () => {
      rt.subscribeCb?.("CHANNEL_ERROR");
      rt.subscribeCb?.("SUBSCRIBED");
    });

    // `router.refresh()` re-renders the RLS-scoped server snapshot into props;
    // the `sig`-keyed effect reconciles it. A browser-client read would run as
    // anon (httpOnly cookies) and blank the list mid-aisle — the mocked client's
    // `from()` throws to keep that from creeping back.
    await waitFor(() => expect(rt.refresh).toHaveBeenCalledTimes(1));
    expect(screen.getAllByTestId("grocery-item").map((el) => el.dataset.name)).toEqual([
      "eggs",
    ]);
  });

  it("does not refresh on the FIRST subscribe (only after a drop)", async () => {
    renderList([row({ id: "g1", name: "eggs" })]);
    await connected();

    expect(rt.refresh).not.toHaveBeenCalled();
  });

  it("reports 'Live updates paused' when no token could be applied (issue #44/#114)", async () => {
    // The token route fails (signed out, network, 5xx): the socket still JOINs
    // on the anon key, but RLS delivers nothing. Claiming "Live" would tell a
    // shopper the other phone's check-offs are arriving when they are not.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));

    renderList([row({ id: "g1", name: "eggs" })]);
    await connected();

    expect(rt.setAuthTokens).toEqual([]);
    await waitFor(() =>
      expect(screen.getByTestId("realtime-status")).toHaveTextContent(
        "Live updates paused",
      ),
    );
    // The list itself is server-rendered, so it is still fully correct.
    expect(screen.getAllByTestId("grocery-item")).toHaveLength(1);
  });
});

/**
 * "We have it" (#171). One tap takes the item off the list — no checkbox, no
 * Complete trip. The row is not deleted (the roll-up planner still needs it, see
 * `rollup-core.test.ts`), it is simply gone from this screen.
 */
describe("GroceryList — we have it", () => {
  const heading = () =>
    screen.getByRole("heading", { name: /Shopping list/ }).textContent ?? "";

  const tapHaveIt = async (name: string) => {
    const item = screen
      .getAllByTestId("grocery-item")
      .find((el) => el.dataset.name === name)!;
    await act(async () => {
      within(item).getByRole("button", { name: "We have it" }).click();
    });
  };

  it("removes the item on one tap, optimistically", async () => {
    renderList([row({ id: "g1", name: "olive oil" })]);
    await connected();
    expect(heading()).toContain("(1 to get)");

    await tapHaveIt("olive oil");

    expect(actions.setHaveIt).toHaveBeenCalledWith("g1", true);
    expect(screen.queryByTestId("grocery-item")).not.toBeInTheDocument();
    // The item is GONE, not merely uncounted.
    expect(heading()).toContain("(0 to get)");
  });

  it("puts the row back when the write fails", async () => {
    actions.setHaveIt.mockImplementation(async () => ({ error: "Nope." }));
    renderList([row({ id: "g1", name: "olive oil", quantity: 2, unit: "cup" })]);
    await connected();

    await tapHaveIt("olive oil");

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Nope."));
    const item = screen.getByTestId("grocery-item");
    expect(within(item).getByText("olive oil")).toBeInTheDocument();
    expect(within(item).getByText("2 cup")).toBeInTheDocument();
    expect(heading()).toContain("(1 to get)");
  });

  it("offers an Undo that restores the row with its quantity, unit and aisle", async () => {
    renderList([
      row({
        id: "g1",
        name: "olive oil",
        quantity: 2,
        unit: "cup",
        sectionId: "s-dairy",
      }),
    ]);
    await connected();

    await tapHaveIt("olive oil");
    const notice = screen.getByTestId("grocery-notice");
    expect(notice).toHaveTextContent("olive oil");

    await act(async () => {
      within(notice).getByRole("button", { name: "Undo" }).click();
    });

    // The undo is the same one-column write, inverted — the row was never
    // deleted, so nothing about it had to be reconstructed.
    expect(actions.setHaveIt).toHaveBeenLastCalledWith("g1", false);
    const item = screen.getByTestId("grocery-item");
    expect(within(item).getByText("2 cup")).toBeInTheDocument();
    expect(
      (screen.getByLabelText("Aisle for olive oil") as HTMLSelectElement).value,
    ).toBe("s-dairy");
    expect(heading()).toContain("(1 to get)");
    // The offer is spent once taken.
    expect(screen.queryByTestId("grocery-notice")).not.toBeInTheDocument();
  });

  it("drops the item live when the other phone claims it", async () => {
    renderList([row({ id: "g1", name: "olive oil" })]);
    await connected();

    await act(async () => {
      rt.handler?.(
        changePayload(
          "UPDATE",
          dbRow({
            id: "g1",
            name: "olive oil",
            have_it: true,
            have_it_at: "2026-09-07T18:00:00Z",
          }),
        ),
      );
    });

    expect(screen.queryByTestId("grocery-item")).not.toBeInTheDocument();
    expect(heading()).toContain("(0 to get)");
  });

  it("keeps the item off the list when an OLDER server snapshot still lists it", async () => {
    // The `revalidatePath` snapshot in flight was rendered before this write
    // committed. Adopting it wholesale would flash the item back onto the list
    // and then remove it again — the same staleness the aisle picker guards
    // against, and far more alarming when the row disappears and reappears.
    let settle: ((result: { ok: true }) => void) | undefined;
    actions.setHaveIt.mockImplementation(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    const { snapshot } = renderList([
      row({ id: "g1", name: "olive oil" }),
      row({ id: "g2", name: "eggs" }),
    ]);
    await connected();

    await tapHaveIt("olive oil");
    expect(screen.getAllByTestId("grocery-item")).toHaveLength(1);

    await act(async () => {
      snapshot([
        row({ id: "g1", name: "olive oil" }),
        row({ id: "g2", name: "eggs", quantity: 12 }),
      ]);
    });

    expect(
      screen.getAllByTestId("grocery-item").map((el) => el.dataset.name),
    ).toEqual(["eggs"]);

    await act(async () => {
      settle?.({ ok: true });
    });
  });
});

/**
 * Aisle grouping (#138). The bucketing itself is exhaustively tested in
 * `sections-core`; here we pin the WIRING — that a group renders as a labelled
 * landmark, that the picker reflects and drives the durable write, and that a
 * move applied on the other phone re-groups this one live.
 */
describe("GroceryList — aisles", () => {
  const groupNames = () =>
    screen.getAllByTestId("section-group").map((el) => el.dataset.name);

  /** Choose an aisle in a row's picker, the way a tap on the chip does. */
  const pickAisle = async (item: string, sectionId: string) => {
    const picker = screen.getByLabelText(`Aisle for ${item}`);
    await act(async () => {
      fireEvent.change(picker, { target: { value: sectionId } });
    });
  };

  it("renders one labelled group per non-empty section, in section order", async () => {
    renderList([
      row({ id: "1", name: "Milk", sectionId: "s-dairy" }),
      row({ id: "2", name: "Kale", sectionId: "s-produce" }),
    ]);
    await connected();

    expect(groupNames()).toEqual(["Produce", "Dairy & Eggs"]);
    const produce = screen
      .getAllByTestId("section-group")
      .find((el) => el.dataset.name === "Produce")!;
    expect(within(produce).getByText("Kale")).toBeTruthy();
    // Each aisle is its own labelled region, so a screen reader can jump
    // between them instead of walking one flat list of forty rows.
    expect(produce.getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("files an unsectioned row into Unsorted, at the end", async () => {
    renderList([
      row({ id: "1", name: "Windex", sectionId: null }),
      row({ id: "2", name: "Kale", sectionId: "s-produce" }),
    ]);
    await connected();

    expect(groupNames()).toEqual(["Produce", "Unsorted"]);
  });

  it("shows the item's current aisle in its picker", async () => {
    renderList([row({ id: "1", name: "Milk", sectionId: "s-dairy" })]);
    await connected();

    const picker = screen.getByLabelText("Aisle for Milk") as HTMLSelectElement;
    expect(picker.value).toBe("s-dairy");
  });

  it("selects Unsorted for a row with no section, rather than blanking", async () => {
    renderList([row({ id: "1", name: "Windex", sectionId: null })]);
    await connected();

    const picker = screen.getByLabelText("Aisle for Windex") as HTMLSelectElement;
    expect(picker.value).toBe("s-unsorted");
  });

  it("moves the row to the chosen aisle and writes it through", async () => {
    renderList([row({ id: "1", name: "Milk", sectionId: null })]);
    await connected();

    await pickAisle("Milk", "s-dairy");

    expect(actions.setItemSection).toHaveBeenCalledWith("1", "s-dairy");
    // Optimistic: the row is under its new heading before the write settles.
    await waitFor(() => expect(groupNames()).toEqual(["Dairy & Eggs"]));
  });

  it("sends the Unsorted section when it is picked back off an aisle", async () => {
    renderList([row({ id: "1", name: "Milk", sectionId: "s-dairy" })]);
    await connected();

    await pickAisle("Milk", "s-unsorted");

    expect(actions.setItemSection).toHaveBeenCalledWith("1", "s-unsorted");
  });

  it("rolls the row back to its old aisle when the write fails", async () => {
    actions.setItemSection.mockImplementation(async () => ({ error: "Nope." }));
    renderList([row({ id: "1", name: "Milk", sectionId: "s-produce" })]);
    await connected();

    await pickAisle("Milk", "s-dairy");

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Nope."));
    expect(groupNames()).toEqual(["Produce"]);
    expect(
      (screen.getByLabelText("Aisle for Milk") as HTMLSelectElement).value,
    ).toBe("s-produce");
  });

  it("re-groups live when the other phone files an item into an aisle", async () => {
    renderList([row({ id: "1", name: "Milk", sectionId: null })]);
    await connected();
    expect(groupNames()).toEqual(["Unsorted"]);

    act(() => {
      rt.handler?.(
        changePayload("UPDATE", dbRow({ id: "1", name: "Milk", section_id: "s-dairy" })),
      );
    });

    await waitFor(() => expect(groupNames()).toEqual(["Dairy & Eggs"]));
  });

  it("keeps an in-flight aisle change when an OLDER server snapshot lands", async () => {
    // Two moves in quick succession: the first one's `revalidatePath` snapshot
    // was rendered before the second one committed, so adopting it wholesale
    // would bounce the second row back to its old aisle and then forward again.
    let settle: ((result: { ok: true }) => void) | undefined;
    actions.setItemSection.mockImplementation(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    const { snapshot } = renderList([
      row({ id: "1", name: "Milk", sectionId: null }),
      row({ id: "2", name: "Kale", sectionId: null }),
    ]);
    await connected();

    await pickAisle("Milk", "s-dairy");
    expect(groupNames()).toEqual(["Dairy & Eggs", "Unsorted"]);

    // Kale's snapshot lands: accurate about Kale, stale about Milk.
    await act(async () => {
      snapshot([
        row({ id: "1", name: "Milk", sectionId: null }),
        row({ id: "2", name: "Kale", sectionId: "s-produce" }),
      ]);
    });

    expect(groupNames()).toEqual(["Produce", "Dairy & Eggs"]);
    await act(async () => {
      settle?.({ ok: true });
    });
  });

  it("takes the server's word once the aisle write has settled", async () => {
    const { snapshot } = renderList([row({ id: "1", name: "Milk", sectionId: "s-dairy" })]);
    await connected();

    // Nothing in flight, so a snapshot that disagrees wins — the server is the
    // source of truth the moment we have no newer local write to protect.
    await act(async () => {
      snapshot([row({ id: "1", name: "Milk", sectionId: "s-produce" })]);
    });

    expect(groupNames()).toEqual(["Produce"]);
  });

  it("renders an ungrouped list when the household has no sections", async () => {
    renderList([row({ id: "1", name: "Milk" })], []);
    await connected();

    expect(screen.queryAllByTestId("section-group")).toHaveLength(0);
    expect(screen.getAllByTestId("grocery-item")).toHaveLength(1);
    // Nothing to pick from, so no picker is offered.
    expect(screen.queryByLabelText("Aisle for Milk")).toBeNull();
  });
});
