import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REACTION_PALETTE } from "@/lib/social/palette";

import {
  ProposalPool,
  type CommentRow,
  type ProposalView,
  type ReactionRow,
} from "./proposal-pool";

/**
 * The week's idea pool with its social layer (issue #9). The pure cores
 * (toggle/tally/reconcile) are exhaustively tested in lib/social; here we verify
 * the COMPONENT wiring: rendering reactions/comments, the fixed palette, the
 * defense-in-depth recipe-link guard, and — via a faked browser client — that the
 * Realtime subscription is filtered by household_id, merges incoming changes by PK,
 * scopes them to the week, and reconciles the SERVER's snapshot on reconnect
 * (issue #114 — the browser client has no session, so it must never read data).
 *
 * NOTE: this exercises the Realtime PLUMBING with a fake channel. Genuine
 * two-client delivery + a real socket drop is auth-gated and verified live
 * (issue #24 / family-validation), not here.
 */

const [THUMBS, HEART] = REACTION_PALETTE;

// Shared, test-controllable fake of the browser Supabase client.
const rt = vi.hoisted(() => ({
  handlers: {} as Record<string, (p: unknown) => void>,
  filters: {} as Record<string, string>,
  subscribeCb: undefined as undefined | ((s: string) => void),
  removeChannel: vi.fn(),
  // Realtime auth (issue #44): record tokens applied to the socket + the order
  // of setAuth vs. subscribe, so we can assert the socket is authenticated as
  // the user BEFORE it joins (anon join => RLS delivers no postgres_changes).
  setAuthTokens: [] as string[],
  events: [] as string[],
  refresh: vi.fn(),
}));

// The reconnect snapshot comes from a SERVER re-render (issue #114): the browser
// client has no session (auth cookies are httpOnly, ADR 0008), so a
// browser-client read would run as anon, be denied by RLS, and blank the board.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: rt.refresh }) }));

vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => {
    const channel = () => {
      const chain: Record<string, unknown> = {
        on: (_e: string, opts: { table: string; filter: string }, handler: (p: unknown) => void) => {
          rt.handlers[opts.table] = handler;
          rt.filters[opts.table] = opts.filter;
          return chain;
        },
        subscribe: (cb: (s: string) => void) => {
          rt.events.push("subscribe");
          rt.subscribeCb = cb;
          // Emit SUBSCRIBED so the channel reports "Live", as the real socket does.
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
    // The real client emits CLOSED as a channel is torn down. The fake does the
    // same, so a deliberate TEARDOWN can be told apart from a dropped socket —
    // conflating them made a re-subscribe look like a reconnect (#114 review).
    const removeChannel = (ch: unknown) => {
      rt.subscribeCb?.("CLOSED");
      return rt.removeChannel(ch);
    };
    return { channel, from, removeChannel, realtime };
  },
}));

// The server actions touch server-only modules; stub them — the toggle/insert
// logic itself is covered by social-core.test.ts.
vi.mock("./social-actions", () => ({
  reactAction: async () => null,
  addCommentAction: async () => null,
}));

// Slotting is a server action too; stub it. The slot orchestration itself is
// covered by slot-core.test.ts — here we only assert the affordance renders.
vi.mock("./slot-actions", () => ({
  slotDishAction: async () => null,
}));

beforeEach(() => {
  rt.handlers = {};
  rt.filters = {};
  rt.subscribeCb = undefined;
  rt.removeChannel.mockClear();
  rt.setAuthTokens = [];
  rt.events = [];
  rt.refresh.mockClear();
  // The component fetches a short-lived access token from /auth/realtime-token
  // and applies it to the socket before subscribing. Stub that endpoint.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
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

/**
 * Wait until the (async) Realtime setup has run: the socket is authenticated
 * and the channel has subscribed + registered its handlers.
 */
async function connected() {
  await waitFor(() => expect(rt.subscribeCb).toBeDefined());
}

const proposals: ProposalView[] = [
  {
    id: "p1",
    dishId: "d1",
    createdAt: "2026-06-22T10:00:00.000Z",
    title: "Carnitas Tacos",
    note: "family favorite",
    sourceUrl: "https://example.com/carnitas",
    proposerName: "Jon",
  },
  {
    id: "p2",
    dishId: "d2",
    createdAt: "2026-06-23T10:00:00.000Z",
    title: "Caesar Salad",
    note: null,
    sourceUrl: null,
    proposerName: "Alex",
  },
];

const memberNames = { me: "Jon", alex: "Alex" };

function renderPool(overrides: Partial<Parameters<typeof ProposalPool>[0]> = {}) {
  return render(
    <ProposalPool
      householdId="hh-1"
      currentMemberId="me"
      weekStart="2026-06-22"
      proposals={proposals}
      initialReactions={[]}
      initialComments={[]}
      memberNames={memberNames}
      {...overrides}
    />,
  );
}

describe("ProposalPool — rendering", () => {
  it("lists each proposal with its title, proposer and note", () => {
    renderPool();
    const pool = screen.getByRole("region", { name: /idea/i });
    expect(within(pool).getByText("Carnitas Tacos")).toBeInTheDocument();
    expect(within(pool).getByText(/Jon/)).toBeInTheDocument();
    expect(within(pool).getByText(/family favorite/)).toBeInTheDocument();
    expect(within(pool).getByText("Caesar Salad")).toBeInTheDocument();
  });

  it("renders a reaction button for every palette emoji on each proposal", () => {
    renderPool({ proposals: [proposals[0]] });
    for (const kind of REACTION_PALETTE) {
      expect(
        screen.getByRole("button", { name: new RegExp(`React ${kind}`) }),
      ).toBeInTheDocument();
    }
  });

  it("links a proposal that has a recipe URL", () => {
    renderPool();
    const link = screen.getByRole("link", { name: /recipe/i });
    expect(link).toHaveAttribute("href", "https://example.com/carnitas");
  });

  it("does not render a link for an unsafe (javascript:) URL (defense in depth)", () => {
    renderPool({
      proposals: [
        {
          id: "evil",
          dishId: "d-evil",
          createdAt: "2026-06-22T10:00:00.000Z",
          title: "Sneaky",
          note: null,
          sourceUrl: "javascript:alert(document.cookie)",
          proposerName: null,
        },
      ],
    });
    expect(screen.queryByRole("link", { name: /recipe/i })).not.toBeInTheDocument();
  });

  it("shows an empty-state when there are no proposals yet", () => {
    renderPool({ proposals: [] });
    const pool = screen.getByRole("region", { name: /idea/i });
    expect(
      within(pool).getByText(/no .*ideas|nothing|be the first/i),
    ).toBeInTheDocument();
  });
});

describe("ProposalPool — reactions tally", () => {
  it("shows counts and marks the current member's own reaction (aria-pressed)", () => {
    renderPool({
      proposals: [proposals[0]],
      initialReactions: [
        { id: "r1", proposal_id: "p1", member_id: "me", kind: THUMBS },
        { id: "r2", proposal_id: "p1", member_id: "alex", kind: THUMBS },
      ],
    });
    const btn = screen.getByRole("button", { name: new RegExp(`React ${THUMBS}`) });
    expect(btn).toHaveTextContent("2");
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });
});

describe("ProposalPool — nudge sort (popular floats up, never auto-places)", () => {
  it("orders proposals by positive-reaction count, most-popular first", () => {
    const older: ProposalView = {
      id: "old",
      dishId: "d-old",
      createdAt: "2026-06-20T10:00:00.000Z",
      title: "Old Idea",
      note: null,
      sourceUrl: null,
      proposerName: null,
    };
    const newer: ProposalView = {
      id: "new",
      dishId: "d-new",
      createdAt: "2026-06-23T10:00:00.000Z",
      title: "New Idea",
      note: null,
      sourceUrl: null,
      proposerName: null,
    };
    renderPool({
      // Input order is the newer one first; nudge sort must float the popular
      // older one above it.
      proposals: [newer, older],
      initialReactions: [
        { id: "r1", proposal_id: "old", member_id: "me", kind: THUMBS },
        { id: "r2", proposal_id: "old", member_id: "alex", kind: HEART },
      ],
    });
    const titles = screen
      .getAllByTestId("proposal-title")
      .map((el) => el.textContent);
    expect(titles).toEqual(["Old Idea", "New Idea"]);
  });

  it("breaks count ties by most-recent (newest first)", () => {
    renderPool({ initialReactions: [] }); // p1 (older) + p2 (newer), 0 reactions
    const titles = screen
      .getAllByTestId("proposal-title")
      .map((el) => el.textContent);
    expect(titles).toEqual(["Caesar Salad", "Carnitas Tacos"]);
  });
});

describe("ProposalPool — ready-to-slot badge", () => {
  it("shows the badge at >= 2 distinct positive reactors", () => {
    renderPool({
      proposals: [proposals[0]],
      initialReactions: [
        { id: "r1", proposal_id: "p1", member_id: "me", kind: THUMBS },
        { id: "r2", proposal_id: "p1", member_id: "alex", kind: HEART },
      ],
    });
    expect(screen.getByText(/ready to slot/i)).toBeInTheDocument();
  });

  it("does NOT badge when one member reacts with several positive kinds (distinct rule)", () => {
    renderPool({
      proposals: [proposals[0]],
      initialReactions: [
        { id: "r1", proposal_id: "p1", member_id: "me", kind: THUMBS },
        { id: "r2", proposal_id: "p1", member_id: "me", kind: HEART },
        { id: "r3", proposal_id: "p1", member_id: "me", kind: REACTION_PALETTE[2] },
      ],
    });
    expect(screen.queryByText(/ready to slot/i)).not.toBeInTheDocument();
  });

  it("does NOT badge a proposal with only neutral reactions", () => {
    const NEUTRAL = REACTION_PALETTE[REACTION_PALETTE.length - 1];
    renderPool({
      proposals: [proposals[0]],
      initialReactions: [
        { id: "r1", proposal_id: "p1", member_id: "me", kind: NEUTRAL },
        { id: "r2", proposal_id: "p1", member_id: "alex", kind: NEUTRAL },
      ],
    });
    expect(screen.queryByText(/ready to slot/i)).not.toBeInTheDocument();
  });
});

describe("ProposalPool — tap-to-slot affordance", () => {
  it("renders a day + meal picker and a Slot button on each proposal", () => {
    renderPool({ proposals: [proposals[0]] });
    expect(
      screen.getByRole("button", { name: /^slot/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/day/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/meal/i)).toBeInTheDocument();
  });
});

describe("ProposalPool — comments", () => {
  it("renders each comment with its author and a timestamp", () => {
    const comments: CommentRow[] = [
      {
        id: "c1",
        proposal_id: "p1",
        member_id: "alex",
        body: "yes please",
        created_at: "2026-06-25T17:30:00.000Z",
      },
    ];
    renderPool({ proposals: [proposals[0]], initialComments: comments });
    expect(screen.getByText("yes please")).toBeInTheDocument();
    expect(screen.getByText("Alex")).toBeInTheDocument();
    expect(
      screen.getByText((_t, el) => el?.tagName.toLowerCase() === "time"),
    ).toHaveAttribute("dateTime", "2026-06-25T17:30:00.000Z");
  });
});

describe("ProposalPool — Realtime subscription", () => {
  it("authenticates the socket with the user's access token BEFORE subscribing (issue #44)", async () => {
    // Root cause of #44: the socket joined with the anon key only, so RLS-gated
    // postgres_changes delivered nothing. The fix fetches the short-lived access
    // token and applies it via realtime.setAuth, and must do so before the join.
    renderPool({ proposals: [proposals[0]] });
    await connected();
    expect(rt.setAuthTokens).toContain("user-jwt");
    // setAuth must precede subscribe so the JOIN carries the user's JWT.
    expect(rt.events.indexOf("setAuth")).toBeLessThan(rt.events.indexOf("subscribe"));
    // ...and only THEN may the UI claim to be live.
    await waitFor(() =>
      expect(screen.getByTestId("realtime-status")).toHaveTextContent("Live"),
    );
  });

  it("subscribes to reactions and comments filtered by household_id (RLS-gated column)", async () => {
    renderPool({ proposals: [proposals[0]] });
    await connected();
    expect(rt.filters.reactions).toBe("household_id=eq.hh-1");
    expect(rt.filters.comments).toBe("household_id=eq.hh-1");
  });

  it("merges an incoming reaction INSERT for a week proposal (count increments)", async () => {
    renderPool({
      proposals: [proposals[0]],
      initialReactions: [
        { id: "r1", proposal_id: "p1", member_id: "me", kind: THUMBS },
      ],
    });
    await connected();
    act(() => {
      rt.handlers.reactions({
        eventType: "INSERT",
        new: { id: "r2", proposal_id: "p1", member_id: "alex", kind: THUMBS },
        old: {},
      });
    });
    const btn = screen.getByRole("button", { name: new RegExp(`React ${THUMBS}`) });
    await waitFor(() => expect(btn).toHaveTextContent("2"));
  });

  it("flips the current member's own 'mine' state when their reaction arrives live", async () => {
    // e.g. the same member acting from a second device: the live echo must mark
    // the pill pressed, not just bump an anonymous count.
    renderPool({ proposals: [proposals[0]], initialReactions: [] });
    await connected();
    const btn = screen.getByRole("button", { name: new RegExp(`React ${THUMBS}`) });
    expect(btn).toHaveAttribute("aria-pressed", "false");

    act(() => {
      rt.handlers.reactions({
        eventType: "INSERT",
        new: { id: "mine1", proposal_id: "p1", member_id: "me", kind: THUMBS },
        old: {},
      });
    });

    await waitFor(() => expect(btn).toHaveAttribute("aria-pressed", "true"));
    expect(btn).toHaveTextContent("1");
  });

  it("removes its channel on unmount (no leaked subscription)", async () => {
    const { unmount } = renderPool({ proposals: [proposals[0]] });
    await connected();
    expect(rt.removeChannel).not.toHaveBeenCalled();
    unmount();
    expect(rt.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("ignores an incoming reaction for a proposal NOT in this week (week scope)", async () => {
    renderPool({ proposals: [proposals[0]], initialReactions: [] });
    await connected();
    act(() => {
      rt.handlers.reactions({
        eventType: "INSERT",
        new: {
          id: "rx",
          proposal_id: "other-week-proposal",
          member_id: "alex",
          kind: THUMBS,
        },
        old: {},
      });
    });
    const btn = screen.getByRole("button", { name: new RegExp(`React ${THUMBS}`) });
    expect(btn).not.toHaveTextContent("1");
  });

  it("removes a reaction on an incoming DELETE (by PK)", async () => {
    renderPool({
      proposals: [proposals[0]],
      initialReactions: [
        { id: "r1", proposal_id: "p1", member_id: "alex", kind: THUMBS },
      ],
    });
    await connected();
    const btn = screen.getByRole("button", { name: new RegExp(`React ${THUMBS}`) });
    expect(btn).toHaveTextContent("1");
    act(() => {
      rt.handlers.reactions({ eventType: "DELETE", new: {}, old: { id: "r1" } });
    });
    await waitFor(() => expect(btn).not.toHaveTextContent("1"));
  });

  it("shows an incoming comment from another member live", async () => {
    renderPool({ proposals: [proposals[0]], initialComments: [] });
    await connected();
    act(() => {
      rt.handlers.comments({
        eventType: "INSERT",
        new: {
          id: "c9",
          proposal_id: "p1",
          member_id: "alex",
          body: "ooh yes",
          created_at: "2026-06-25T18:00:00.000Z",
        },
        old: {},
      });
    });
    await waitFor(() => expect(screen.getByText("ooh yes")).toBeInTheDocument());
  });
});

describe("ProposalPool — drop + reconnect resilience (issue #114)", () => {
  it("asks the SERVER for the authoritative snapshot after a reconnect", async () => {
    const initialReactions: ReactionRow[] = [
      { id: "r1", proposal_id: "p1", member_id: "me", kind: THUMBS },
    ];
    const { rerender } = renderPool({
      proposals: [proposals[0]],
      initialReactions,
    });
    await connected();
    expect(rt.refresh).not.toHaveBeenCalled();

    await act(async () => {
      rt.subscribeCb?.("CHANNEL_ERROR");
      rt.subscribeCb?.("SUBSCRIBED");
    });

    // `router.refresh()` re-renders the RLS-scoped server snapshot into props;
    // the sig-keyed effect reconciles it. A browser-client read would run as
    // anon (httpOnly cookies), be denied by RLS, and blank the board — the
    // mocked client's `from()` throws to keep that from creeping back.
    await waitFor(() => expect(rt.refresh).toHaveBeenCalledTimes(1));

    // Nothing is lost while the server re-render is in flight.
    expect(
      screen.getByRole("button", { name: new RegExp(`React ${THUMBS}`) }),
    ).toHaveTextContent("1");

    // The server's truth arrives as new props: the thumbs is gone, a heart was
    // added. State converges on it (reconcileByPk), with no dup or loss.
    rerender(
      <ProposalPool
        householdId="hh-1"
        currentMemberId="me"
        weekStart="2026-06-22"
        proposals={[proposals[0]]}
        initialReactions={[
          { id: "r2", proposal_id: "p1", member_id: "alex", kind: HEART },
        ]}
        initialComments={[]}
        memberNames={memberNames}
      />,
    );

    const heart = screen.getByRole("button", { name: new RegExp(`React ${HEART}`) });
    await waitFor(() => expect(heart).toHaveTextContent("1"));
    expect(
      screen.getByRole("button", { name: new RegExp(`React ${THUMBS}`) }),
    ).not.toHaveTextContent("1");
  });

  it("does not refresh on the FIRST subscribe (only after a drop)", async () => {
    renderPool({ proposals: [proposals[0]] });
    await connected();

    expect(rt.refresh).not.toHaveBeenCalled();
  });

  it("still refreshes for a drop that happened BEFORE a proposal-set change", async () => {
    // The fix must not trade a spurious refresh for a MISSED one. `wasDisconnected`
    // deliberately outlives any single channel: a genuine drop recorded on the old
    // channel is still owed a server re-render once the replacement connects. This
    // is the test that fails if someone later "simplifies" the ref to a per-effect
    // variable — which the cancelled-guard makes tempting.
    const { rerender } = renderPool({ proposals: [proposals[0]] });
    await connected();

    // A real drop on the live channel — no recovery yet.
    await act(async () => {
      rt.subscribeCb?.("CHANNEL_ERROR");
    });
    expect(rt.refresh).not.toHaveBeenCalled();

    // Now the proposal set changes, tearing that channel down mid-drop.
    await act(async () => {
      rerender(
        <ProposalPool
          householdId="hh-1"
          currentMemberId="me"
          weekStart="2026-06-22"
          proposals={proposals}
          initialReactions={[]}
          initialComments={[]}
          memberNames={memberNames}
        />,
      );
    });
    await connected();

    // The replacement channel connects and the debt is paid, exactly once.
    await waitFor(() => expect(rt.refresh).toHaveBeenCalledTimes(1));
  });

  it("still refreshes for a drop that happens AFTER a proposal-set change", async () => {
    const { rerender } = renderPool({ proposals: [proposals[0]] });
    await connected();

    await act(async () => {
      rerender(
        <ProposalPool
          householdId="hh-1"
          currentMemberId="me"
          weekStart="2026-06-22"
          proposals={proposals}
          initialReactions={[]}
          initialComments={[]}
          memberNames={memberNames}
        />,
      );
    });
    await connected();
    expect(rt.refresh).not.toHaveBeenCalled();

    // The replacement channel drops for real and recovers: still a reconnect.
    await act(async () => {
      rt.subscribeCb?.("CHANNEL_ERROR");
      rt.subscribeCb?.("SUBSCRIBED");
    });

    await waitFor(() => expect(rt.refresh).toHaveBeenCalledTimes(1));
  });

  it("does not refresh when a proposal-set change re-subscribes the channel", async () => {
    // The effect is keyed on the proposal ids, so adding a proposal tears the
    // channel down and opens a new one. Teardown emits CLOSED — but that is US
    // closing the socket, not the network dropping it, so the fresh channel's
    // first SUBSCRIBED must NOT be treated as a reconnect. Otherwise every new
    // idea posted to the board costs an extra server re-render.
    const { rerender } = renderPool({ proposals: [proposals[0]] });
    await connected();
    expect(rt.refresh).not.toHaveBeenCalled();

    await act(async () => {
      rerender(
        <ProposalPool
          householdId="hh-1"
          currentMemberId="me"
          weekStart="2026-06-22"
          proposals={proposals}
          initialReactions={[]}
          initialComments={[]}
          memberNames={memberNames}
        />,
      );
    });
    await connected();

    expect(rt.refresh).not.toHaveBeenCalled();
  });

  it("keeps what is on screen through a reconnect (never blanks the pool)", async () => {
    // The #114 regression: the reconnect handler replaced state with the EMPTY
    // result of an anon read. Until the server snapshot lands, state stands.
    renderPool({
      proposals: [proposals[0]],
      initialComments: [
        {
          id: "c1",
          proposal_id: "p1",
          member_id: "alex",
          body: "yes please",
          created_at: "2026-06-25T17:30:00.000Z",
        },
      ],
    });
    await connected();

    await act(async () => {
      rt.subscribeCb?.("CHANNEL_ERROR");
      rt.subscribeCb?.("SUBSCRIBED");
    });

    await waitFor(() => expect(rt.refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByText("yes please")).toBeInTheDocument();
  });
});

describe("ProposalPool — an unauthenticated socket is never reported as Live", () => {
  it("shows 'Live updates paused' when no token could be applied (issue #44 silent failure)", async () => {
    // The token route fails (signed out, network, 5xx): the socket would still
    // JOIN on the anon key, and RLS would deliver nothing. Reporting "Live"
    // would be a lie — the exact silent-failure mode #44 fixed on the wire.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));

    renderPool({ proposals: [proposals[0]] });
    await connected();

    expect(rt.setAuthTokens).toEqual([]);
    await waitFor(() =>
      expect(screen.getByTestId("realtime-status")).toHaveTextContent(
        "Live updates paused",
      ),
    );
  });
});
