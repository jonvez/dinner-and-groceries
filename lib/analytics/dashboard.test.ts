import { describe, expect, it, vi } from "vitest";

import {
  DASHBOARD_EVENT_TYPES,
  loadDashboardSummary,
  summarizeDashboard,
  WINDOW_DAYS,
  type DashboardEvent,
  type DashboardMember,
} from "./dashboard";

/**
 * The PO dashboard's aggregation (issue #17, ADR 0014). Pure + injected-client,
 * like `lib/grocery/rollup.ts` and `app/grocery/list-core.ts`, so the numbers
 * Jon reads are pinned without a live DB.
 *
 * What's pinned here:
 *   - the FIXED 30-day window and its boundaries (no date picker — ADR 0014);
 *   - per-member participation counts, INCLUDING a member who has done nothing:
 *     they appear with zeroes, because an absent row is indistinguishable from
 *     a bug (and a missing kid is exactly the wrong thing to make Jon wonder
 *     about);
 *   - adoption = active DAYS per member from `session_start`/`sign_in`, plus
 *     DAU/WAU, with unattributed (`member_id is null`) usage events counted in
 *     the totals but attributable to nobody;
 *   - trips come from `trip_completed` ONLY — "we have it" is not a trip
 *     (ADR 0012);
 *   - an empty dataset yields explicit `hasActivity: false` flags, never a
 *     zero-filled panel that reads like a breakage;
 *   - the read asks for only the event types a panel renders (no
 *     `recipe_ingested`, no `screen_view`) and degrades to empty on a failure.
 */

const NOW = new Date("2026-09-15T12:00:00.000Z");

/** `days` before NOW (+ optional hours), as an ISO timestamp. */
function ago(days: number, hours = 0): string {
  return new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();
}

const MEMBERS: DashboardMember[] = [
  { id: "m-jon", displayName: "Jon" },
  { id: "m-jojo", displayName: "Jojo" },
  { id: "m-kai", displayName: "Kai" },
];

const ev = (
  eventType: DashboardEvent["eventType"],
  memberId: string | null,
  createdAt: string,
): DashboardEvent => ({ eventType, memberId, createdAt });

describe("summarizeDashboard — the window", () => {
  it("is a fixed 30 days ending now", () => {
    expect(WINDOW_DAYS).toBe(30);
    const { window } = summarizeDashboard([], MEMBERS, { now: NOW });
    expect(window.days).toBe(30);
    expect(window.end).toBe(NOW.toISOString());
    expect(window.start).toBe("2026-08-16T12:00:00.000Z");
  });

  it("includes an event exactly on the 30-day boundary and excludes one older", () => {
    const events = [
      ev("trip_completed", "m-jon", ago(30)),
      ev("trip_completed", "m-jon", new Date(NOW.getTime() - 30 * 86_400_000 - 1).toISOString()),
    ];
    expect(summarizeDashboard(events, MEMBERS, { now: NOW }).trips.completed).toBe(1);
  });

  it("ignores an event stamped in the future (clock skew is not participation)", () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    const summary = summarizeDashboard([ev("trip_completed", "m-jon", future)], MEMBERS, {
      now: NOW,
    });
    expect(summary.trips.completed).toBe(0);
  });

  it("ignores an unparseable timestamp rather than counting it", () => {
    const summary = summarizeDashboard([ev("trip_completed", "m-jon", "not-a-date")], MEMBERS, {
      now: NOW,
    });
    expect(summary.trips.completed).toBe(0);
  });
});

describe("summarizeDashboard — adoption", () => {
  it("counts active DAYS per member, not events per member", () => {
    const events = [
      ev("session_start", "m-jojo", ago(1, 1)),
      ev("session_start", "m-jojo", ago(1, 2)), // same UTC day
      ev("sign_in", "m-jojo", ago(3)),
      ev("session_start", "m-jon", ago(2)),
    ];
    const { adoption } = summarizeDashboard(events, MEMBERS, { now: NOW });
    expect(adoption.byMember).toEqual([
      { memberId: "m-jojo", displayName: "Jojo", activeDays: 2 },
      { memberId: "m-jon", displayName: "Jon", activeDays: 1 },
      { memberId: "m-kai", displayName: "Kai", activeDays: 0 },
    ]);
    expect(adoption.usageEvents).toBe(4);
    expect(adoption.hasActivity).toBe(true);
  });

  it("reports DAU and WAU as distinct members, not event counts", () => {
    const events = [
      ev("session_start", "m-jon", ago(0, 1)), // today
      ev("session_start", "m-jon", ago(0, 2)), // today again — same member
      ev("session_start", "m-jojo", ago(3)), // this week
      ev("sign_in", "m-kai", ago(20)), // in the window, not the week
    ];
    const { adoption } = summarizeDashboard(events, MEMBERS, { now: NOW });
    expect(adoption.activeToday).toBe(1);
    expect(adoption.activeThisWeek).toBe(2);
  });

  it("counts an unattributed usage event in the total but for no member", () => {
    // `sign_in` can fire before a membership exists (ADR 0014), and a removed
    // member's events survive with member_id nulled: real usage, nobody to
    // attribute it to. It must not vanish, and must not be invented onto a row.
    const { adoption } = summarizeDashboard([ev("sign_in", null, ago(1))], MEMBERS, {
      now: NOW,
    });
    expect(adoption.usageEvents).toBe(1);
    expect(adoption.unattributedUsageEvents).toBe(1);
    expect(adoption.activeThisWeek).toBe(0);
    expect(adoption.byMember.every((m) => m.activeDays === 0)).toBe(true);
    expect(adoption.hasActivity).toBe(true);
  });

  it("attributes nothing to a member_id that is not in the household roster", () => {
    const { adoption, participation } = summarizeDashboard(
      [ev("session_start", "m-ghost", ago(1)), ev("proposal_created", "m-ghost", ago(1))],
      MEMBERS,
      { now: NOW },
    );
    expect(adoption.byMember.map((m) => m.memberId)).toEqual(["m-jojo", "m-jon", "m-kai"]);
    expect(adoption.usageEvents).toBe(1);
    expect(participation.total).toBe(1);
    expect(participation.byMember.every((m) => m.total === 0)).toBe(true);
  });

  it("says so explicitly when nobody has used the app", () => {
    const { adoption } = summarizeDashboard(
      [ev("trip_completed", "m-jon", ago(1))],
      MEMBERS,
      { now: NOW },
    );
    expect(adoption.hasActivity).toBe(false);
    expect(adoption.usageEvents).toBe(0);
  });
});

describe("summarizeDashboard — per-member participation", () => {
  it("counts each participation type per member, by display name", () => {
    const events = [
      ev("proposal_created", "m-jojo", ago(2)),
      ev("proposal_created", "m-jojo", ago(4)),
      ev("reaction_added", "m-jojo", ago(2)),
      ev("comment_added", "m-jon", ago(1)),
      ev("slot_filled", "m-jon", ago(1)),
      ev("slot_filled", "m-jon", ago(1)),
      // Not participation: usage + grocery events have their own panels.
      ev("session_start", "m-jon", ago(1)),
      ev("trip_completed", "m-jon", ago(1)),
    ];
    const { participation } = summarizeDashboard(events, MEMBERS, { now: NOW });
    // Alphabetical: "Jojo" before "Jon" (a leaderboard would put them in
    // whichever order flattered somebody — that is the point).
    expect(participation.byMember).toEqual([
      {
        memberId: "m-jojo",
        displayName: "Jojo",
        proposalsCreated: 2,
        reactionsAdded: 1,
        commentsAdded: 0,
        slotsFilled: 0,
        total: 3,
      },
      {
        memberId: "m-jon",
        displayName: "Jon",
        proposalsCreated: 0,
        reactionsAdded: 0,
        commentsAdded: 1,
        slotsFilled: 2,
        total: 3,
      },
      {
        memberId: "m-kai",
        displayName: "Kai",
        proposalsCreated: 0,
        reactionsAdded: 0,
        commentsAdded: 0,
        slotsFilled: 0,
        total: 0,
      },
    ]);
    expect(participation.total).toBe(6);
    expect(participation.hasActivity).toBe(true);
  });

  it("lists a member who has done nothing at all, with zeroes", () => {
    const { participation } = summarizeDashboard([], MEMBERS, { now: NOW });
    expect(participation.byMember.map((m) => m.displayName)).toEqual(["Jojo", "Jon", "Kai"]);
    expect(participation.byMember.every((m) => m.total === 0)).toBe(true);
    expect(participation.hasActivity).toBe(false);
  });

  it("orders members alphabetically, not by who did the most", () => {
    // Deliberately NOT a leaderboard (north star: low-key, judgment-free).
    const events = [ev("proposal_created", "m-kai", ago(1))];
    const { participation } = summarizeDashboard(events, MEMBERS, { now: NOW });
    expect(participation.byMember.map((m) => m.displayName)).toEqual(["Jojo", "Jon", "Kai"]);
  });
});

describe("summarizeDashboard — trips", () => {
  it("counts completed trips and lists built, and nothing else", () => {
    const events = [
      ev("trip_completed", "m-jon", ago(1)),
      ev("trip_completed", "m-jojo", ago(9)),
      ev("grocery_list_built", "m-jon", ago(1)),
      // "We have it" emits NO event (ADR 0012) — this stands in for the other
      // grocery traffic that must never inflate the trip count.
      ev("slot_filled", "m-jon", ago(1)),
    ];
    const { trips } = summarizeDashboard(events, MEMBERS, { now: NOW });
    expect(trips).toEqual({ completed: 2, listsBuilt: 1, hasActivity: true });
  });

  it("says so explicitly when there were no trips", () => {
    const { trips } = summarizeDashboard([ev("slot_filled", "m-jon", ago(1))], MEMBERS, {
      now: NOW,
    });
    expect(trips).toEqual({ completed: 0, listsBuilt: 0, hasActivity: false });
  });
});

describe("summarizeDashboard — an empty database", () => {
  it("renders every panel as an explicit empty state, not zeros that look broken", () => {
    const summary = summarizeDashboard([], [], { now: NOW });
    expect(summary.adoption).toEqual({
      hasActivity: false,
      byMember: [],
      activeToday: 0,
      activeThisWeek: 0,
      usageEvents: 0,
      unattributedUsageEvents: 0,
    });
    expect(summary.participation).toEqual({ hasActivity: false, byMember: [], total: 0 });
    expect(summary.trips).toEqual({ completed: 0, listsBuilt: 0, hasActivity: false });
  });
});

// ---------------------------------------------------------------------------
// The read half: an injected Supabase-like client, no live DB.
// ---------------------------------------------------------------------------

type QueryResult = { data: unknown; error: unknown };
type Filter = { op: string; column: string; value?: unknown };
type Recorded = { table: string; columns: string; filters: Filter[] };

function makeClient(opts: { events?: QueryResult; members?: QueryResult }) {
  const selects: Recorded[] = [];
  const empty: QueryResult = { data: [], error: null };

  const from = vi.fn((table: string) => ({
    select: (columns: string) => {
      const filters: Filter[] = [];
      const result = table === "events" ? (opts.events ?? empty) : (opts.members ?? empty);
      const builder = {
        gte(column: string, value: unknown) {
          filters.push({ op: "gte", column, value });
          return builder;
        },
        in(column: string, value: unknown) {
          filters.push({ op: "in", column, value });
          return builder;
        },
        order(column: string) {
          filters.push({ op: "order", column });
          return builder;
        },
        then<T>(resolve: (r: QueryResult) => T) {
          selects.push({ table, columns, filters });
          return Promise.resolve(result).then(resolve);
        },
      };
      return builder;
    },
  }));

  return {
    client: from as unknown as never,
    supabase: { from } as unknown as Parameters<typeof loadDashboardSummary>[0],
    selects,
  };
}

describe("loadDashboardSummary", () => {
  it("reads only the window's events, and only the types a panel renders", async () => {
    const { supabase, selects } = makeClient({});
    await loadDashboardSummary(supabase, { now: NOW });

    const events = selects.find((s) => s.table === "events")!;
    expect(events.columns).toBe("event_type, member_id, created_at");
    expect(events.filters).toEqual([
      { op: "gte", column: "created_at", value: "2026-08-16T12:00:00.000Z" },
      { op: "in", column: "event_type", value: DASHBOARD_EVENT_TYPES },
    ]);
    // `recipe_ingested` and `screen_view` have no panel, so they are not read.
    expect(DASHBOARD_EVENT_TYPES).not.toContain("recipe_ingested");
    expect(DASHBOARD_EVENT_TYPES).not.toContain("screen_view");
  });

  it("joins members for DISPLAY NAMES only — no roles, no emails, no user ids", async () => {
    const { supabase, selects } = makeClient({});
    await loadDashboardSummary(supabase, { now: NOW });
    const members = selects.find((s) => s.table === "members")!;
    expect(members.columns).toBe("id, display_name");
  });

  it("reads no table other than events and members", async () => {
    const { supabase, selects } = makeClient({});
    await loadDashboardSummary(supabase, { now: NOW });
    expect([...new Set(selects.map((s) => s.table))].sort()).toEqual(["events", "members"]);
  });

  it("maps snake_case rows into the summary", async () => {
    const { supabase } = makeClient({
      members: { data: [{ id: "m-jojo", display_name: "Jojo" }], error: null },
      events: {
        data: [
          { event_type: "proposal_created", member_id: "m-jojo", created_at: ago(1) },
          { event_type: "trip_completed", member_id: "m-jojo", created_at: ago(2) },
          { event_type: "session_start", member_id: "m-jojo", created_at: ago(2) },
        ],
        error: null,
      },
    });
    const summary = await loadDashboardSummary(supabase, { now: NOW });
    expect(summary.participation.byMember).toEqual([
      {
        memberId: "m-jojo",
        displayName: "Jojo",
        proposalsCreated: 1,
        reactionsAdded: 0,
        commentsAdded: 0,
        slotsFilled: 0,
        total: 1,
      },
    ]);
    expect(summary.trips.completed).toBe(1);
    expect(summary.adoption.byMember[0].activeDays).toBe(1);
  });

  it("degrades to an empty dashboard when a read fails, rather than throwing", async () => {
    const { supabase } = makeClient({
      events: { data: null, error: { message: "boom" } },
      members: { data: null, error: { message: "boom" } },
    });
    const summary = await loadDashboardSummary(supabase, { now: NOW });
    expect(summary.adoption.hasActivity).toBe(false);
    expect(summary.participation.byMember).toEqual([]);
    expect(summary.trips.completed).toBe(0);
  });
});
