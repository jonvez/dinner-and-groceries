import { describe, expect, it } from "vitest";

import { resolveRecipeActor } from "./actor";

/**
 * Fail-closed identity resolution for the ingest Server Actions (issue #12c).
 * Mirrors app/board/actor.test.ts's resolveActor coverage, minus the week
 * concept this flow doesn't have.
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
  return client as unknown as Parameters<typeof resolveRecipeActor>[0];
}

describe("resolveRecipeActor", () => {
  it("returns null when there is no verified session (fail closed)", async () => {
    const client = actorClient({ user: null, householdId: "hh-1", member: { id: "m1" } });
    expect(await resolveRecipeActor(client)).toBeNull();
  });

  it("returns null when the session has no household", async () => {
    const client = actorClient({ user: { id: "u1" }, householdId: null, member: { id: "m1" } });
    expect(await resolveRecipeActor(client)).toBeNull();
  });

  it("returns null when the user has no membership row", async () => {
    const client = actorClient({ user: { id: "u1" }, householdId: "hh-1", member: null });
    expect(await resolveRecipeActor(client)).toBeNull();
  });

  it("resolves household + member for a full session", async () => {
    const client = actorClient({ user: { id: "u1" }, householdId: "hh-1", member: { id: "m1" } });
    expect(await resolveRecipeActor(client)).toEqual({ householdId: "hh-1", memberId: "m1" });
  });
});
