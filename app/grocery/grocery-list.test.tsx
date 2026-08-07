import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GroceryList, formatAmount, toChange } from "./grocery-list";
import type { GroceryRow } from "./list-core";

/**
 * The live shopping list (issue #15). The data cores are exhaustively tested in
 * `list-core` / `mutations-core` / `trip-core`; here we pin the COMPONENT
 * wiring, mirroring `app/board/proposal-pool.test.tsx`:
 *   - the Realtime socket is authenticated as the user BEFORE the channel joins,
 *     and the channel is household-scoped (`filter: household_id=eq.<id>`);
 *   - incoming changes merge by PK, are scoped to this week, and an ARCHIVED row
 *     (purchased_at set) leaves the active list — that's how the other phone
 *     sees "complete trip";
 *   - a missing quantity/unit renders as NOTHING (never "0"/"1");
 *   - "we already have it" de-emphasizes without removing the row;
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
  refetch: [] as unknown[],
}));

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
    // Snapshot re-fetch (loadGroceryList over the browser client).
    const from = (table: string) => ({
      select: () => {
        const result = {
          data: table === "grocery_items" ? rt.refetch : [],
          error: null,
        };
        const chain: Record<string, unknown> = {
          eq: () => chain,
          is: () => chain,
          order: () => chain,
          then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
            Promise.resolve(result).then(onF, onR),
        };
        return chain;
      },
    });
    return { channel, from, removeChannel: rt.removeChannel, realtime };
  },
}));

type ToggleFn = (id: string, value: boolean) => Promise<{ ok: true }>;

const actions = vi.hoisted(() => ({
  setChecked: vi.fn<ToggleFn>(async () => ({ ok: true })),
  setHaveIt: vi.fn<ToggleFn>(async () => ({ ok: true })),
}));

vi.mock("./actions", () => ({
  addAdHocItemAction: async () => null,
  addCatalogItemToListAction: async () => ({ ok: true }),
  buildGroceryListAction: async () => ({ ok: true, added: 0, removed: 0 }),
  completeTripAction: async () => ({ ok: true, archived: 0, promotable: [] }),
  promoteToCatalogAction: async () => ({ ok: true, promoted: 0 }),
  setCheckedAction: (id: string, checked: boolean) => actions.setChecked(id, checked),
  setHaveItAction: (id: string, haveIt: boolean) => actions.setHaveIt(id, haveIt),
}));

beforeEach(() => {
  rt.handler = undefined;
  rt.filter = "";
  rt.channelName = "";
  rt.subscribeCb = undefined;
  rt.removeChannel.mockClear();
  rt.setAuthTokens = [];
  rt.events = [];
  rt.refetch = [];
  actions.setChecked.mockClear();
  actions.setHaveIt.mockClear();
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
  haveIt: false,
  checked: false,
  edited: false,
  position: 0,
  createdAt: "2026-08-07T00:00:00.000Z",
  ...o,
});

function renderList(items: GroceryRow[]) {
  return render(
    <GroceryList
      weekId="wk-1"
      householdId="hh-1"
      initialItems={items}
      catalog={[{ id: "c1", name: "Olive oil", defaultUnit: null }]}
    />,
  );
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
  it("drops a row from another week", () => {
    expect(toChange(changePayload("INSERT", dbRow({ id: "g1", name: "x", week_id: "wk-2" })), "wk-1")).toBeNull();
  });

  it("treats an archived row as a removal from the active list", () => {
    expect(
      toChange(
        changePayload("UPDATE", dbRow({ id: "g1", name: "x", purchased_at: "2026-08-07T19:00:00Z" })),
        "wk-1",
      ),
    ).toEqual({ type: "DELETE", id: "g1" });
  });

  it("maps a DELETE by primary key", () => {
    expect(toChange(changePayload("DELETE", {}, { id: "g1" }), "wk-1")).toEqual({
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

  it("de-emphasizes a have-it row without removing it", async () => {
    renderList([row({ id: "g1", name: "olive oil", haveIt: true })]);
    await connected();

    const item = screen.getByTestId("grocery-item");
    expect(item).toBeInTheDocument();
    expect(within(item).getByRole("button", { name: "Got it already" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(item).getByText("olive oil").parentElement?.className).toContain(
      "line-through",
    );
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

  it("re-fetches the authoritative snapshot after a reconnect", async () => {
    renderList([row({ id: "g1", name: "eggs" })]);
    await connected();

    rt.refetch = [dbRow({ id: "g2", name: "milk" })];
    await act(async () => {
      rt.subscribeCb?.("CHANNEL_ERROR");
      rt.subscribeCb?.("SUBSCRIBED");
    });

    await waitFor(() => {
      const names = screen.getAllByTestId("grocery-item").map((el) => el.dataset.name);
      expect(names).toEqual(["milk"]);
    });
  });
});
