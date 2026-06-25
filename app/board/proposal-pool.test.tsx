import { act, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
 * scopes them to the week, and reconciles a fresh snapshot on reconnect.
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
  inCalls: [] as { table: string; ids: string[] }[],
  data: { reactions: [] as unknown[], comments: [] as unknown[] },
  removeChannel: vi.fn(),
}));

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
          rt.subscribeCb = cb;
          return chain;
        },
      };
      return chain;
    };
    const from = (table: string) => ({
      select: () => ({
        in: (_col: string, ids: string[]) => {
          rt.inCalls.push({ table, ids });
          const result = {
            data: table === "reactions" ? rt.data.reactions : rt.data.comments,
            error: null,
          };
          return {
            order: () => Promise.resolve(result),
            then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
              Promise.resolve(result).then(onF, onR),
          };
        },
      }),
    });
    return { channel, from, removeChannel: rt.removeChannel };
  },
}));

// The server actions touch server-only modules; stub them — the toggle/insert
// logic itself is covered by social-core.test.ts.
vi.mock("./social-actions", () => ({
  reactAction: async () => null,
  addCommentAction: async () => null,
}));

beforeEach(() => {
  rt.handlers = {};
  rt.filters = {};
  rt.subscribeCb = undefined;
  rt.inCalls = [];
  rt.data = { reactions: [], comments: [] };
  rt.removeChannel.mockClear();
});

const proposals: ProposalView[] = [
  {
    id: "p1",
    title: "Carnitas Tacos",
    note: "family favorite",
    sourceUrl: "https://example.com/carnitas",
    proposerName: "Jon",
  },
  {
    id: "p2",
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
  it("subscribes to reactions and comments filtered by household_id (RLS-gated column)", () => {
    renderPool({ proposals: [proposals[0]] });
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

  it("ignores an incoming reaction for a proposal NOT in this week (week scope)", async () => {
    renderPool({ proposals: [proposals[0]], initialReactions: [] });
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
    const btn = screen.getByRole("button", { name: new RegExp(`React ${THUMBS}`) });
    expect(btn).toHaveTextContent("1");
    act(() => {
      rt.handlers.reactions({ eventType: "DELETE", new: {}, old: { id: "r1" } });
    });
    await waitFor(() => expect(btn).not.toHaveTextContent("1"));
  });

  it("shows an incoming comment from another member live", async () => {
    renderPool({ proposals: [proposals[0]], initialComments: [] });
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

describe("ProposalPool — drop + reconnect resilience", () => {
  it("re-fetches the authoritative snapshot and reconciles by PK on reconnect", async () => {
    renderPool({
      proposals: [proposals[0]],
      initialReactions: [
        { id: "r1", proposal_id: "p1", member_id: "me", kind: THUMBS },
      ],
    });

    // The server's truth after the drop: the thumbs is gone, a heart was added.
    rt.data.reactions = [
      { id: "r2", proposal_id: "p1", member_id: "alex", kind: HEART },
    ] as ReactionRow[];

    await act(async () => {
      rt.subscribeCb?.("CHANNEL_ERROR");
      rt.subscribeCb?.("SUBSCRIBED");
    });

    // A snapshot re-fetch happened, scoped to the week's proposal ids.
    await waitFor(() =>
      expect(rt.inCalls.some((c) => c.table === "reactions")).toBe(true),
    );
    expect(rt.inCalls[0].ids).toEqual(["p1"]);

    // State converged on the server snapshot: thumbs cleared, heart present.
    const thumbs = screen.getByRole("button", {
      name: new RegExp(`React ${THUMBS}`),
    });
    const heart = screen.getByRole("button", { name: new RegExp(`React ${HEART}`) });
    await waitFor(() => expect(heart).toHaveTextContent("1"));
    expect(thumbs).not.toHaveTextContent("1");
  });
});
