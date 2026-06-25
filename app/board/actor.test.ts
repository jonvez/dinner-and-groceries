import { describe, expect, it } from "vitest";

import { resolveActor, resolveWeekId, type Actor } from "./actor";

/**
 * The action-layer identity + untrusted-input boundary (issue #8, security
 * rework). `resolveActor` must fail closed when there is no verified session or
 * no membership; `resolveWeekId` must reject a crafted `?week=` and otherwise
 * re-normalize it to the household's canonical boundary BEFORE any write.
 */

// --- resolveActor fakes ---------------------------------------------------

function actorClient(opts: {
  user: { id: string } | null;
  householdId: string | null;
  member: { id: string } | null;
  household: { week_start_day: number } | null;
}) {
  const client = {
    auth: { getUser: async () => ({ data: { user: opts.user } }) },
    rpc: async () => ({ data: opts.householdId }),
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: table === "members" ? opts.member : null,
          }),
        }),
        maybeSingle: async () => ({
          data: table === "households" ? opts.household : null,
        }),
      }),
    }),
  };
  return client as unknown as Parameters<typeof resolveActor>[0];
}

describe("resolveActor", () => {
  it("returns null when there is no verified session (fail closed)", async () => {
    const client = actorClient({
      user: null,
      householdId: "hh-1",
      member: { id: "m1" },
      household: { week_start_day: 1 },
    });
    expect(await resolveActor(client)).toBeNull();
  });

  it("returns null when the session has no household", async () => {
    const client = actorClient({
      user: { id: "u1" },
      householdId: null,
      member: { id: "m1" },
      household: { week_start_day: 1 },
    });
    expect(await resolveActor(client)).toBeNull();
  });

  it("returns null when the user has no membership row", async () => {
    const client = actorClient({
      user: { id: "u1" },
      householdId: "hh-1",
      member: null,
      household: { week_start_day: 1 },
    });
    expect(await resolveActor(client)).toBeNull();
  });

  it("resolves household + member + week-start preference for a full session", async () => {
    const client = actorClient({
      user: { id: "u1" },
      householdId: "hh-1",
      member: { id: "m1" },
      household: { week_start_day: 0 },
    });
    expect(await resolveActor(client)).toEqual({
      householdId: "hh-1",
      memberId: "m1",
      weekStartDay: 0,
    });
  });

  it("defaults to a Monday start when the household row is missing", async () => {
    const client = actorClient({
      user: { id: "u1" },
      householdId: "hh-1",
      member: { id: "m1" },
      household: null,
    });
    const actor = await resolveActor(client);
    expect(actor?.weekStartDay).toBe(1);
  });
});

// --- resolveWeekId fakes --------------------------------------------------

function weekClient() {
  const upserts: { vals: unknown; opts: unknown }[] = [];
  const client = {
    from: () => ({
      upsert: (vals: unknown, opts: unknown) => {
        upserts.push({ vals, opts });
        return {
          select: () => ({
            single: async () => ({ data: { id: "w1" }, error: null }),
          }),
        };
      },
    }),
  };
  return {
    client: client as unknown as Parameters<typeof resolveWeekId>[0],
    upserts,
  };
}

const ACTOR: Actor = { householdId: "hh-1", memberId: "m1", weekStartDay: 1 };

describe("resolveWeekId", () => {
  it("rejects a garbage week param without touching the DB", async () => {
    const { client, upserts } = weekClient();
    const result = await resolveWeekId(client, ACTOR, "not-a-date");
    expect("error" in result).toBe(true);
    expect(upserts).toHaveLength(0);
  });

  it("rejects an impossible calendar date", async () => {
    const { client, upserts } = weekClient();
    const result = await resolveWeekId(client, ACTOR, "2026-02-30");
    expect("error" in result).toBe(true);
    expect(upserts).toHaveLength(0);
  });

  it("normalizes a valid off-grid date to the canonical week boundary before writing", async () => {
    const { client, upserts } = weekClient();
    // 2026-06-24 is a Wednesday; Monday-start canonical week is 2026-06-22.
    const result = await resolveWeekId(client, ACTOR, "2026-06-24");
    expect(result).toEqual({ weekId: "w1" });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].vals).toEqual({
      household_id: "hh-1",
      start_date: "2026-06-22",
    });
  });

  it("respects a Sunday-start household when normalizing", async () => {
    const { client, upserts } = weekClient();
    const sundayActor: Actor = { ...ACTOR, weekStartDay: 0 };
    await resolveWeekId(client, sundayActor, "2026-06-24");
    // Wednesday -> previous Sunday is 2026-06-21.
    expect(upserts[0].vals).toMatchObject({ start_date: "2026-06-21" });
  });
});
