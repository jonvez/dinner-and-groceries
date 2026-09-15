import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `session_start` Server Action (issue #210). Sessions are long-lived, so
 * `sign_in` alone under-counts daily use to the point where the dashboard's
 * adoption panel would look empty (ADR 0014) — this action is what the
 * once-per-browser-session beacon calls.
 *
 * Contract pinned here:
 *   - household + member come from the VERIFIED session (`auth.getUser()` plus
 *     the explicit `user_id` filter — the #62 lesson), never from the request,
 *   - exactly one `session_start` row, payload `{}`, no PII,
 *   - it fails closed and REPORTS the failure (`{ ok: false }`) so the beacon
 *     leaves its guard unset and a later navigation can try again,
 *   - it never throws, whatever the transport does.
 */

const mocks = vi.hoisted(() => {
  const inserts: { table: string; vals: Record<string, unknown> }[] = [];
  const state = {
    userId: "auth-user-1" as string | null,
    householdId: "hh-1" as string | null,
    memberId: "m-1" as string | null,
    throwOnInsert: false,
  };

  const client = {
    auth: {
      getUser: async () => ({
        data: { user: state.userId ? { id: state.userId } : null },
      }),
    },
    rpc: async () => ({ data: state.householdId }),
    from: (table: string) => ({
      insert: (vals: Record<string, unknown>) => {
        if (state.throwOnInsert) throw new Error("analytics transport down");
        inserts.push({ table, vals });
        return Promise.resolve({ error: null });
      },
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: state.memberId ? { id: state.memberId } : null,
          }),
        }),
      }),
    }),
  };

  return { inserts, state, client };
});

vi.mock("@/lib/supabase/server-component", () => ({
  createServerComponentClient: async () => mocks.client as never,
}));

const { recordSessionStartAction } = await import("./session-actions");

function emitted() {
  return mocks.inserts
    .filter((row) => row.table === "events")
    .map((row) => row.vals);
}

beforeEach(() => {
  mocks.inserts.length = 0;
  mocks.state.userId = "auth-user-1";
  mocks.state.householdId = "hh-1";
  mocks.state.memberId = "m-1";
  mocks.state.throwOnInsert = false;
});

describe("recordSessionStartAction", () => {
  it("emits one session_start with an empty payload, attributed to the member", async () => {
    const result = await recordSessionStartAction();

    expect(result).toEqual({ ok: true });
    expect(emitted()).toEqual([
      {
        household_id: "hh-1",
        member_id: "m-1",
        event_type: "session_start",
        payload: {},
      },
    ]);
  });

  it("emits nothing when there is no verified session", async () => {
    mocks.state.userId = null;

    const result = await recordSessionStartAction();

    expect(result).toEqual({ ok: false });
    expect(emitted()).toEqual([]);
  });

  it("emits nothing when the caller has no household yet", async () => {
    mocks.state.householdId = null;

    const result = await recordSessionStartAction();

    expect(result).toEqual({ ok: false });
    expect(emitted()).toEqual([]);
  });

  it("reports not-ok (and never throws) when the insert throws", async () => {
    mocks.state.throwOnInsert = true;

    await expect(recordSessionStartAction()).resolves.toEqual({ ok: false });
  });
});
