import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Home's owner-only region (issue #17, ADR 0014 §4).
 *
 * The dashboard has NO nav entry: `components/app-nav.tsx` is a static,
 * propless link list, and a "Dashboard" tab the teens can see but cannot open
 * invites exactly the questions this feature must never raise (north star). The
 * only way in is a link here, beside the invite panel, rendered only when the
 * VERIFIED signed-in member is the owner (#62: `members_select` lets any member
 * read all co-members, so an unfiltered read would return the owner's row and
 * show every kid the link).
 *
 * The link is convenience, not security — `/dashboard` 404s for a non-owner and
 * `events_select` is owner-only in RLS — but a visible link to a screen a teen
 * cannot open is exactly the "what's that?" this issue exists to avoid.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/app/session-actions", () => ({
  recordSessionStartAction: async () => ({ ok: true }),
}));
vi.mock("./join/actions", () => ({ generateInviteAction: async () => null }));

type Member = { user_id: string; display_name: string; role: "owner" | "member" };
let client: unknown;

function signedInAs(user: { id: string } | null, members: Member[]) {
  let rows: Member[] = [];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((col: keyof Member, val: unknown) => {
      rows = rows.filter((r) => r[col] === val);
      return builder;
    }),
    maybeSingle: vi.fn(async () => ({ data: rows[0] ?? null })),
  };
  client = {
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => {
      rows = table === "members" ? [...members] : [];
      return builder;
    },
  };
}

vi.mock("@/lib/supabase/server-component", () => ({
  createServerComponentClient: async () => client,
}));

const HOUSEHOLD: Member[] = [
  { user_id: "owner-uid", display_name: "Jon", role: "owner" },
  { user_id: "teen-uid", display_name: "Jojo", role: "member" },
];

import Home from "./page";

describe("Home — the dashboard link", () => {
  it("links the OWNER to /dashboard", async () => {
    signedInAs({ id: "owner-uid" }, HOUSEHOLD);
    render(await Home());
    expect(screen.getByRole("link", { name: /dashboard/i })).toHaveAttribute(
      "href",
      "/dashboard",
    );
  });

  it("shows a NON-owner member no dashboard link at all", async () => {
    signedInAs({ id: "teen-uid" }, HOUSEHOLD);
    render(await Home());
    expect(screen.queryByRole("link", { name: /dashboard/i })).not.toBeInTheDocument();
  });

  it("keeps the dashboard out of the nav, even for the owner", async () => {
    signedInAs({ id: "owner-uid" }, HOUSEHOLD);
    render(await Home());
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("link", { name: /dashboard/i })).not.toBeInTheDocument();
  });
});
