import { describe, expect, it } from "vitest";

import { resolveGroceryActor } from "./actor";

/**
 * Fail-closed identity resolution for the grocery Server Actions (issue #14).
 * Mirrors app/recipes/new/actor.test.ts: household + member come ONLY from the
 * verified session, and any missing link resolves to null rather than a partial
 * (or worse, caller-supplied) identity.
 */

function actorClient(opts: {
  user: { id: string } | null;
  householdId: string | null;
  member: { id: string } | null;
}) {
  const client = {
    auth: { getUser: async () => ({ data: { user: opts.user } }) },
    rpc: async () => ({ data: opts.householdId }),
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: opts.member }),
        }),
      }),
    }),
  };
  return client as unknown as Parameters<typeof resolveGroceryActor>[0];
}

describe("resolveGroceryActor", () => {
  it("returns null when there is no verified session (fail closed)", async () => {
    const client = actorClient({ user: null, householdId: "hh-1", member: { id: "m1" } });
    expect(await resolveGroceryActor(client)).toBeNull();
  });

  it("returns null when the session has no household", async () => {
    const client = actorClient({ user: { id: "u1" }, householdId: null, member: { id: "m1" } });
    expect(await resolveGroceryActor(client)).toBeNull();
  });

  it("returns null when the user has no membership row", async () => {
    const client = actorClient({ user: { id: "u1" }, householdId: "hh-1", member: null });
    expect(await resolveGroceryActor(client)).toBeNull();
  });

  it("resolves household + member for a full session", async () => {
    const client = actorClient({ user: { id: "u1" }, householdId: "hh-1", member: { id: "m1" } });
    expect(await resolveGroceryActor(client)).toEqual({ householdId: "hh-1", memberId: "m1" });
  });
});
