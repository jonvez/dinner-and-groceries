import { describe, expect, it, vi } from "vitest";

import { resolveCurrentMember } from "./current-member";

/**
 * Regression guard for issue #62. The home page must greet the SIGNED-IN user
 * and derive owner-ness from THEIR membership row — never from an arbitrary
 * co-member. The `members_select` RLS policy lets any household member read ALL
 * co-members, so an unfiltered read (`.limit(1)`) returns whichever row was
 * inserted first (the owner). The `user_id` filter is what actually scopes the
 * lookup; this test fails closed if that filter is ever dropped again.
 */

type Member = {
  user_id: string;
  display_name: string;
  role: "owner" | "member";
};

// A household whose members are ALL visible under RLS (owner inserted first).
// The fake `from("members")` builder only narrows to a single member once
// `.eq("user_id", …)` is applied — mirroring how the real query is scoped.
function householdClient(opts: {
  user: { id: string } | null;
  members: Member[];
}) {
  const eq = vi.fn((col: keyof Member, val: unknown) => {
    rows = rows.filter((r) => r[col] === val);
    return builder;
  });
  let rows: Member[] = [];
  const builder = {
    select: vi.fn(() => builder),
    eq,
    maybeSingle: vi.fn(async () => ({ data: rows[0] ?? null })),
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: opts.user } }) },
    from: (table: string) => {
      rows = table === "members" ? [...opts.members] : [];
      return builder;
    },
  };
  return {
    client: client as unknown as Parameters<typeof resolveCurrentMember>[0],
    eq,
  };
}

const HOUSEHOLD: Member[] = [
  // Owner inserted first: an unfiltered `.limit(1)` would return this row.
  { user_id: "owner-uid", display_name: "Jon", role: "owner" },
  { user_id: "jojo-uid", display_name: "Jojo", role: "member" },
];

describe("resolveCurrentMember", () => {
  it("returns null when there is no verified session (fail closed)", async () => {
    const { client } = householdClient({ user: null, members: HOUSEHOLD });
    expect(await resolveCurrentMember(client)).toBeNull();
  });

  it("returns null when the signed-in user has no membership row", async () => {
    const { client } = householdClient({
      user: { id: "stranger-uid" },
      members: HOUSEHOLD,
    });
    expect(await resolveCurrentMember(client)).toBeNull();
  });

  it("greets the SIGNED-IN member, not an arbitrary co-member", async () => {
    // Jojo (a non-owner, inserted second) signs in; she must see herself, not
    // the owner Jon whose row an unfiltered read would return first.
    const { client } = householdClient({
      user: { id: "jojo-uid" },
      members: HOUSEHOLD,
    });
    expect(await resolveCurrentMember(client)).toEqual({
      displayName: "Jojo",
      isOwner: false,
    });
  });

  it("derives owner-ness from the signed-in user's own role", async () => {
    const { client } = householdClient({
      user: { id: "owner-uid" },
      members: HOUSEHOLD,
    });
    expect(await resolveCurrentMember(client)).toEqual({
      displayName: "Jon",
      isOwner: true,
    });
  });

  it("scopes the members lookup to the verified user id", async () => {
    const { client, eq } = householdClient({
      user: { id: "jojo-uid" },
      members: HOUSEHOLD,
    });
    await resolveCurrentMember(client);
    expect(eq).toHaveBeenCalledWith("user_id", "jojo-uid");
  });
});
