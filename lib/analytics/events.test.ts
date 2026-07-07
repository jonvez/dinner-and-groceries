import { describe, expect, it, vi } from "vitest";

import { emitEvent, type EmitEventInput, type EventType } from "./events";

/**
 * The typed server-side analytics emission helper (issue #16). Tested over an
 * injected Supabase-like client — no live DB (the RLS household-scoping +
 * append-only guarantees are proven by pgTAP, `15_events_rls_test.sql`). Here we
 * pin the application contract:
 *   - one row is inserted into `events` with EXACTLY the whitelisted columns
 *     (household_id, member_id, event_type, payload) — never Google identity/PII,
 *   - `memberId` is optional: omitting it writes a null-member (pre-membership)
 *     usage event,
 *   - `payload` defaults to an empty object,
 *   - the event type is constrained to the ADR 0004 taxonomy at COMPILE time,
 *   - the helper fails closed when the insert errors.
 */

/** Records every insert so the emitted row shape is assertable. */
function makeClient(opts: { insertError?: unknown } = {}) {
  const inserts: { table: string; vals: Record<string, unknown> }[] = [];

  const from = vi.fn((table: string) => ({
    insert: vi.fn((vals: Record<string, unknown>) => {
      inserts.push({ table, vals });
      return Promise.resolve({ error: opts.insertError ?? null });
    }),
  }));

  return {
    client: { from } as unknown as Parameters<typeof emitEvent>[0],
    calls: { inserts },
  };
}

const BASE: EmitEventInput = {
  householdId: "hh-1",
  eventType: "proposal_created",
  memberId: "m1",
  payload: { proposal_id: "p1" },
};

describe("emitEvent", () => {
  it("inserts one events row with exactly the whitelisted columns", async () => {
    const { client, calls } = makeClient();

    const result = await emitEvent(client, BASE);

    expect(result).toEqual({ ok: true });
    expect(calls.inserts).toEqual([
      {
        table: "events",
        vals: {
          household_id: "hh-1",
          member_id: "m1",
          event_type: "proposal_created",
          payload: { proposal_id: "p1" },
        },
      },
    ]);
  });

  it("writes a null member for a pre-membership usage event (memberId omitted)", async () => {
    const { client, calls } = makeClient();

    const result = await emitEvent(client, {
      householdId: "hh-1",
      eventType: "sign_in",
    });

    expect(result).toEqual({ ok: true });
    expect(calls.inserts[0].vals).toEqual({
      household_id: "hh-1",
      member_id: null,
      event_type: "sign_in",
      payload: {},
    });
  });

  it("defaults payload to an empty object when omitted", async () => {
    const { client, calls } = makeClient();

    await emitEvent(client, {
      householdId: "hh-1",
      eventType: "session_start",
      memberId: null,
    });

    expect(calls.inserts[0].vals.payload).toEqual({});
  });

  it("never writes Google identity / PII columns (member_id is the only identity)", async () => {
    const { client, calls } = makeClient();

    await emitEvent(client, BASE);

    const keys = Object.keys(calls.inserts[0].vals);
    expect(keys.sort()).toEqual(
      ["event_type", "household_id", "member_id", "payload"].sort(),
    );
    // No Google-identity fields ever reach the row.
    for (const forbidden of ["email", "sub", "user_id", "name", "picture"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("fails closed when the insert errors", async () => {
    const { client } = makeClient({ insertError: { message: "boom" } });

    const result = await emitEvent(client, BASE);

    expect(result.ok).toBe(false);
  });
});

/**
 * Type-level contract (validated by `tsc --noEmit`, not at runtime):
 *   - the event type is the fixed ADR 0004 taxonomy — an out-of-taxonomy string
 *     is a COMPILE error, so a feature slice can't emit an ad hoc event,
 *   - the input surface carries NO email/sub/user_id field — PII can't be passed
 *     through the typed API by construction.
 */
describe("emitEvent typed surface", () => {
  it("constrains the event type to the taxonomy at compile time", () => {
    const valid: EventType = "trip_completed";
    expect(valid).toBe("trip_completed");

    // @ts-expect-error — "app_open" is not in the ADR 0004 taxonomy.
    const invalid: EventType = "app_open";
    expect(invalid).toBeDefined();
  });

  it("has no PII fields on the input type", () => {
    const input: EmitEventInput = {
      householdId: "hh-1",
      eventType: "screen_view",
      // @ts-expect-error — email is not part of the emission surface (no PII).
      email: "kid@example.com",
    };
    expect(input.householdId).toBe("hh-1");
  });
});
